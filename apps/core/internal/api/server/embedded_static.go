package server

import (
	"io/fs"
	"mime"
	"net/http"
	"path"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

type embeddedSPAConfig struct {
	FS         fs.FS
	Root       string
	PathPrefix string
}

func newEmbeddedSPAHandler(config embeddedSPAConfig) gin.HandlerFunc {
	const indexFile = "index.html"
	subFS, err := fs.Sub(config.FS, config.Root)
	if err != nil {
		panic("failed to create embedded SPA filesystem: " + err.Error())
	}

	return func(c *gin.Context) {
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Next()
			return
		}

		urlPath := c.Request.URL.Path
		if !matchesPathPrefix(urlPath, config.PathPrefix) {
			c.Next()
			return
		}

		cleanPath := embeddedFilePath(urlPath, config.PathPrefix)
		data, readErr := fs.ReadFile(subFS, cleanPath)
		if readErr != nil {
			if filepath.Ext(cleanPath) != "" {
				c.Next()
				return
			}
			data, readErr = fs.ReadFile(subFS, indexFile)
			if readErr != nil {
				c.Next()
				return
			}
			cleanPath = indexFile
		}

		if cleanPath == "service-worker.js" {
			c.Header("Cache-Control", "no-cache")
		}
		c.Data(http.StatusOK, detectEmbeddedContentType(cleanPath, data), data)
		c.Abort()
	}
}

func matchesPathPrefix(urlPath string, prefix string) bool {
	if prefix == "/" {
		return true
	}
	trimmedPrefix := strings.TrimSuffix(prefix, "/")
	return urlPath == trimmedPrefix || strings.HasPrefix(urlPath, trimmedPrefix+"/")
}

func embeddedFilePath(urlPath string, prefix string) string {
	if prefix != "/" {
		urlPath = strings.TrimPrefix(urlPath, strings.TrimSuffix(prefix, "/"))
	}
	cleanPath := strings.TrimPrefix(path.Clean(urlPath), "/")
	if cleanPath == "." || cleanPath == "" {
		return "index.html"
	}
	return cleanPath
}

func detectEmbeddedContentType(filename string, data []byte) string {
	ext := filepath.Ext(filename)
	if mimeType := mime.TypeByExtension(ext); mimeType != "" {
		if strings.HasPrefix(mimeType, "text/") ||
			mimeType == "application/javascript" ||
			mimeType == "application/json" {
			if strings.Contains(strings.ToLower(mimeType), "charset=") {
				return mimeType
			}
			return mimeType + "; charset=utf-8"
		}
		return mimeType
	}

	switch ext {
	case ".js", ".mjs":
		return "application/javascript; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".wasm":
		return "application/wasm"
	case ".svg":
		return "image/svg+xml"
	case ".webp":
		return "image/webp"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	case ".ttf":
		return "font/ttf"
	case ".otf":
		return "font/otf"
	case ".ico":
		return "image/x-icon"
	case ".webmanifest":
		return "application/manifest+json"
	}

	return http.DetectContentType(data)
}
