package server

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	webShareMaxBodyBytes  = 64 * 1024
	webShareMaxTextRunes  = 16 * 1024
	webShareMaxTitleRunes = 512
)

func handleWebShareTarget(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(
		c.Writer,
		c.Request.Body,
		webShareMaxBodyBytes,
	)

	var parseErr error
	if strings.HasPrefix(c.GetHeader("Content-Type"), "multipart/form-data") {
		parseErr = c.Request.ParseMultipartForm(webShareMaxBodyBytes)
	} else {
		parseErr = c.Request.ParseForm()
	}

	params := url.Values{}
	if parseErr == nil {
		appendWebShareField(
			params,
			"title",
			c.Request.FormValue("title"),
			webShareMaxTitleRunes,
		)
		appendWebShareField(
			params,
			"text",
			c.Request.FormValue("text"),
			webShareMaxTextRunes,
		)
		appendWebShareField(
			params,
			"url",
			c.Request.FormValue("url"),
			webShareMaxTextRunes,
		)
	}

	target := "/#/share"
	if query := params.Encode(); query != "" {
		target += "?" + query
	}
	c.Redirect(http.StatusSeeOther, target)
}

func appendWebShareField(
	params url.Values,
	name string,
	value string,
	maxRunes int,
) {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return
	}

	runes := []rune(normalized)
	if len(runes) > maxRunes {
		normalized = string(runes[:maxRunes])
	}
	params.Set(name, normalized)
}
