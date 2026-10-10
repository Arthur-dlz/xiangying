package repo

import (
	"errors"

	"caorushizi.cn/mediago/internal/db"
	"gorm.io/gorm"
)

// ErrConversionNotFound is returned when a conversion record is not found by ID.
var ErrConversionNotFound = errors.New("conversion_not_found")

// ConversionRepository is the data access layer for conversion records.
type ConversionRepository struct {
	db *gorm.DB
}

// NewConversionRepository creates a ConversionRepository.
func NewConversionRepository(database *db.Database) *ConversionRepository {
	return &ConversionRepository{db: database.DB}
}

// writeDB keeps conversion mutations to their single SQL statement instead
// of adding a GORM transaction around each write.
func (r *ConversionRepository) writeDB() *gorm.DB {
	return r.db.Session(&gorm.Session{SkipDefaultTransaction: true})
}

// Create creates a conversion record.
func (r *ConversionRepository) Create(conv *db.Conversion) (*db.Conversion, error) {
	if err := r.writeDB().Create(conv).Error; err != nil {
		return nil, err
	}
	return conv, nil
}

// FindByID looks up a conversion record by ID.
func (r *ConversionRepository) FindByID(id int64) (*db.Conversion, error) {
	var conv db.Conversion
	err := r.db.Where("id = ?", id).First(&conv).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &conv, nil
}

// FindByIDOrFail looks up a conversion record by ID, returning an error if not found.
func (r *ConversionRepository) FindByIDOrFail(id int64) (*db.Conversion, error) {
	conv, err := r.FindByID(id)
	if err != nil {
		return nil, err
	}
	if conv == nil {
		return nil, ErrConversionNotFound
	}
	return conv, nil
}

// ConversionPaginationResult holds the result of a paginated query.
type ConversionPaginationResult struct {
	Items []*db.Conversion `json:"items"`
	Total int64            `json:"total"`
}

// FindWithPagination queries conversion records with pagination.
func (r *ConversionRepository) FindWithPagination(current, pageSize int) (*ConversionPaginationResult, error) {
	if current <= 0 {
		current = 1
	}
	if pageSize <= 0 {
		pageSize = 50
	}

	var total int64
	if err := r.db.Model(&db.Conversion{}).Count(&total).Error; err != nil {
		return nil, err
	}

	var items []*db.Conversion
	offset := (current - 1) * pageSize
	err := r.db.Order("createdDate ASC").Order("id ASC").Offset(offset).Limit(pageSize).Find(&items).Error
	if err != nil {
		return nil, err
	}

	return &ConversionPaginationResult{Items: items, Total: total}, nil
}

// UpdateStatus updates the status, progress, outputPath, and error fields.
// outputPath is only written when a non-empty value is supplied so a
// progress-only update cannot clear a previously persisted output path, and a
// nil errMsg clears any stale failure text instead of leaving it behind.
func (r *ConversionRepository) UpdateStatus(id int64, status string, progress int, outputPath string, errMsg *string) error {
	updates := map[string]any{
		"status":   status,
		"progress": progress,
	}
	if outputPath != "" {
		updates["outputPath"] = outputPath
	}
	if errMsg != nil {
		updates["error"] = *errMsg
	} else {
		updates["error"] = ""
	}
	return r.writeDB().Model(&db.Conversion{}).Where("id = ?", id).Updates(updates).Error
}

// TransitionStatus applies a status change only when the record is currently in
// one of the from statuses. This makes start/stop/finish transitions atomic so
// concurrent operations cannot both win, and reports whether a row was updated.
func (r *ConversionRepository) TransitionStatus(id int64, from []string, status string, progress int, outputPath string, errMsg *string) (bool, error) {
	if len(from) == 0 {
		return false, errors.New("conversion transition requires at least one source status")
	}
	updates := map[string]any{
		"status":   status,
		"progress": progress,
	}
	if outputPath != "" {
		updates["outputPath"] = outputPath
	}
	if errMsg != nil {
		updates["error"] = *errMsg
	} else {
		updates["error"] = ""
	}
	result := r.writeDB().Model(&db.Conversion{}).
		Where("id = ? AND status IN ?", id, from).
		Updates(updates)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

// Delete removes a conversion record.
func (r *ConversionRepository) Delete(id int64) error {
	return r.writeDB().Delete(&db.Conversion{}, id).Error
}
