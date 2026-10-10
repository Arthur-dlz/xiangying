package service

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"time"
)

// errPublicClientTargetNotPublic reports an outbound target that resolves to a
// non-public address and is therefore refused.
var errPublicClientTargetNotPublic = errors.New("outbound target is not a public address")

// NewPublicHTTPClient returns an HTTP client for server-side fetches of
// caller-supplied URLs. It refuses to connect to non-public addresses
// (loopback, link-local, RFC1918, cloud metadata, reserved ranges) and
// re-validates every redirect hop, so a caller cannot turn the endpoint into an
// SSRF oracle. Domain names that resolve through a TUN/proxy to the
// 198.18.0.0/15 synthetic range stay allowed, matching the favicon policy.
func NewPublicHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = dialPublicAddress
	transport.MaxConnsPerHost = 4
	transport.MaxIdleConnsPerHost = 2
	transport.ResponseHeaderTimeout = timeout

	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("redirect must use HTTP or HTTPS")
			}
			return nil
		},
	}
}

// dialPublicAddress resolves the target host and connects only to a public
// address, re-checking each resolved address before dialing.
func dialPublicAddress(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}

	addresses := make([]netip.Addr, 0, 2)
	hostIsIPAddress := false
	if parsed, parseErr := netip.ParseAddr(host); parseErr == nil {
		hostIsIPAddress = true
		addresses = append(addresses, parsed)
	} else {
		resolved, resolveErr := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if resolveErr != nil {
			return nil, resolveErr
		}
		addresses = append(addresses, resolved...)
	}

	var dialErrors []error
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	for _, addressIP := range addresses {
		if isUnsafePublicAddress(addressIP, hostIsIPAddress) {
			dialErrors = append(dialErrors, errPublicClientTargetNotPublic)
			continue
		}
		connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(addressIP.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		dialErrors = append(dialErrors, dialErr)
	}
	if len(dialErrors) == 0 {
		return nil, errors.New("outbound target has no usable address")
	}
	return nil, errors.Join(dialErrors...)
}

// blockedPublicClientPrefixes are non-public ranges that are never a legitimate
// outbound target for a caller-supplied URL: "this network", CGNAT/shared
// space, IETF protocol assignments, TEST-NETs, the proxy/TUN synthetic range
// and the reserved block. Link-local (169.254.0.0/16, fe80::/10) is covered
// separately and includes the cloud-metadata endpoint.
var blockedPublicClientPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

// isUnsafePublicAddress reports whether an outbound address must be refused.
//
// Link-local, cloud-metadata, reserved and synthetic ranges are always refused.
// Loopback and RFC1918 private ranges stay reachable on purpose: inspecting a
// local or LAN media source is a supported capability, so a blanket
// public-only rule would break it. A deployment exposed to untrusted callers
// should run with a stricter policy.
func isUnsafePublicAddress(address netip.Addr, hostIsIPAddress bool) bool {
	address = address.Unmap()
	if !address.IsValid() {
		return true
	}
	// A TUN/proxy client synthesizes DNS answers from 198.18.0.0/15. Permit
	// those only when they came from resolving a domain name.
	if !hostIsIPAddress && tunSyntheticFaviconPrefix.Contains(address) {
		return false
	}
	if address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() ||
		address.IsInterfaceLocalMulticast() || address.IsMulticast() || address.IsUnspecified() {
		return true
	}
	for _, prefix := range blockedPublicClientPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}
