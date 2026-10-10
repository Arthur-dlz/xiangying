package handler

import (
	"net/http"
	"strconv"

	"caorushizi.cn/mediago/internal/api/dto"
	"caorushizi.cn/mediago/internal/i18n"
	"github.com/gin-gonic/gin"
)

const (
	errorCodeInvalidID           = "invalid_id"
	errorCodeInvalidRequest      = "invalid_request"
	errorCodeInternalError       = "internal_error"
	errorCodeDownloadNotFound    = "download_not_found"
	errorCodeConversionNotFound  = "conversion_not_found"
	errorCodeFavoriteNotFound    = "favorite_not_found"
	errorCodeTaskNotFound        = "task_not_found"
	errorCodeSourcesCountInvalid = "sources_count_invalid"
)

func parseDownloadID(c *gin.Context) (int64, bool) {
	return parsePositiveID(c)
}

func parsePositiveID(c *gin.Context) (int64, bool) {
	rawID := c.Param("id")
	if rawID == "" {
		writeInvalidID(c)
		return 0, false
	}
	for _, char := range rawID {
		if char < '0' || char > '9' {
			writeInvalidID(c)
			return 0, false
		}
	}

	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		writeInvalidID(c)
		return 0, false
	}
	return id, true
}

func writeInvalidID(c *gin.Context) {
	writeErrorResponse(c, http.StatusBadRequest, errorCodeInvalidID, i18n.T(c, i18n.MsgInvalidID))
}

func writeInvalidRequest(c *gin.Context) {
	writeErrorResponse(c, http.StatusBadRequest, errorCodeInvalidRequest, i18n.T(c, i18n.MsgInvalidRequest))
}

func writeInternalError(c *gin.Context) {
	writeErrorResponse(c, http.StatusInternalServerError, errorCodeInternalError, i18n.T(c, i18n.MsgInternalError))
}

func writeDownloadNotFound(c *gin.Context, id int64) {
	writeErrorResponse(c, http.StatusNotFound, errorCodeDownloadNotFound, i18n.T(c, i18n.MsgVideoNotFound, id))
}

func writeConversionNotFound(c *gin.Context, id int64) {
	writeErrorResponse(c, http.StatusNotFound, errorCodeConversionNotFound, i18n.T(c, i18n.MsgConversionNotFound, id))
}

func writeFavoriteNotFound(c *gin.Context, id int64) {
	writeErrorResponse(c, http.StatusNotFound, errorCodeFavoriteNotFound, i18n.T(c, i18n.MsgFavoriteNotFound, id))
}

func writeSourcesCountInvalid(c *gin.Context) {
	writeErrorResponse(c, http.StatusBadRequest, errorCodeSourcesCountInvalid, i18n.T(c, i18n.MsgSourcesCountInvalid))
}

func writeTaskNotFound(c *gin.Context) {
	writeErrorResponse(c, http.StatusNotFound, errorCodeTaskNotFound, i18n.T(c, i18n.MsgTaskNotFound))
}

func writeErrorResponse(c *gin.Context, status int, errorCode, message string) {
	c.JSON(status, dto.ErrorResponse{
		Success:   false,
		Code:      status,
		Message:   message,
		ErrorCode: errorCode,
	})
}
