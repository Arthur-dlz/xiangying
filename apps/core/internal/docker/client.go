package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxProxyResponseBytes = 32 << 20

var (
	ErrDisabled         = errors.New("Docker integration is disabled")
	ErrInvalidTarget    = errors.New("invalid Docker target URL")
	ErrRecursiveTarget  = errors.New("Docker target points to the local Core")
	ErrResponseTooLarge = errors.New("Docker response exceeds proxy size limit")
)

type ConfigGetter interface {
	Get(key string) any
}

type ForwardRequest struct {
	Method         string
	Path           string
	RawQuery       string
	Body           io.Reader
	ContentType    string
	AcceptLanguage string
}

type ForwardResponse struct {
	StatusCode  int
	ContentType string
	Body        []byte
}

type Client struct {
	config    ConfigGetter
	transport http.RoundTripper
}

func NewClient(config ConfigGetter) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	return &Client{config: config, transport: transport}
}

func (c *Client) Forward(ctx context.Context, incomingHost string, request ForwardRequest) (ForwardResponse, error) {
	baseURL, apiKey, err := c.currentTarget(incomingHost)
	if err != nil {
		return ForwardResponse{}, err
	}
	if (request.Path != "/healthy" && !strings.HasPrefix(request.Path, "/api/")) || strings.Contains(request.Path, "..") {
		return ForwardResponse{}, ErrInvalidTarget
	}

	target := *baseURL
	target.Path = strings.TrimRight(baseURL.Path, "/") + request.Path
	target.RawPath = ""
	target.RawQuery = request.RawQuery
	target.Fragment = ""

	upstream, err := http.NewRequestWithContext(ctx, request.Method, target.String(), request.Body)
	if err != nil {
		return ForwardResponse{}, fmt.Errorf("create Docker request: %w", err)
	}
	if request.ContentType != "" {
		upstream.Header.Set("Content-Type", request.ContentType)
	}
	if request.AcceptLanguage != "" {
		upstream.Header.Set("Accept-Language", request.AcceptLanguage)
	}
	if apiKey != "" {
		upstream.Header.Set("X-API-Key", apiKey)
	}

	client := &http.Client{
		Transport: c.transport,
		Timeout:   30 * time.Second,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if next.URL.Scheme != "http" && next.URL.Scheme != "https" {
				return errors.New("Docker redirect must use HTTP or HTTPS")
			}
			if !strings.EqualFold(next.URL.Host, baseURL.Host) {
				return errors.New("Docker redirect changed host")
			}
			if baseURL.Scheme == "https" && next.URL.Scheme != "https" {
				return errors.New("Docker redirect downgraded HTTPS")
			}
			if len(via) >= 5 {
				return errors.New("too many Docker redirects")
			}
			if apiKey != "" {
				next.Header.Set("X-API-Key", apiKey)
			}
			return nil
		},
	}
	response, err := client.Do(upstream)
	if err != nil {
		return ForwardResponse{}, fmt.Errorf("forward Docker request: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxProxyResponseBytes+1))
	if err != nil {
		return ForwardResponse{}, fmt.Errorf("read Docker response: %w", err)
	}
	if len(body) > maxProxyResponseBytes {
		return ForwardResponse{}, ErrResponseTooLarge
	}
	return ForwardResponse{
		StatusCode:  response.StatusCode,
		ContentType: response.Header.Get("Content-Type"),
		Body:        body,
	}, nil
}

func (c *Client) currentTarget(incomingHost string) (*url.URL, string, error) {
	enabled, _ := c.config.Get("enableDocker").(bool)
	if !enabled {
		return nil, "", ErrDisabled
	}
	rawURL, _ := c.config.Get("dockerUrl").(string)
	target, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") || target.User != nil {
		return nil, "", ErrInvalidTarget
	}
	if (target.Path == "" || target.Path == "/") && sameEndpoint(target, incomingHost) {
		return nil, "", ErrRecursiveTarget
	}
	target.RawQuery = ""
	target.Fragment = ""
	apiKey, _ := c.config.Get("apiKey").(string)
	return target, apiKey, nil
}

func sameEndpoint(target *url.URL, incomingHost string) bool {
	targetName, targetPort := splitEndpoint(target.Host, target.Scheme)
	incomingName, incomingPort := splitEndpoint(strings.TrimSpace(incomingHost), target.Scheme)
	if targetName == "" || incomingName == "" || targetPort != incomingPort {
		return false
	}
	if strings.EqualFold(targetName, incomingName) {
		return true
	}
	return isLoopbackHost(targetName) && isLoopbackHost(incomingName)
}

func splitEndpoint(hostPort, scheme string) (string, string) {
	if host, port, err := net.SplitHostPort(hostPort); err == nil {
		return strings.Trim(host, "[]"), port
	}
	port := "80"
	if scheme == "https" {
		port = "443"
	}
	return strings.Trim(hostPort, "[]"), port
}

func isLoopbackHost(host string) bool {
	normalized := strings.ToLower(strings.TrimSuffix(host, "."))
	if normalized == "localhost" || strings.HasSuffix(normalized, ".localhost") {
		return true
	}
	ip := net.ParseIP(normalized)
	return ip != nil && ip.IsLoopback()
}
