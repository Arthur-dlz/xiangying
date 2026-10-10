package assets

import "embed"

//go:embed player/*
var PlayerFS embed.FS

//go:embed web/*
var WebFS embed.FS
