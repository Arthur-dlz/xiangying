# Frontend

The React-based frontend application that provides the user interface for MediaGo, used in both Electron desktop app and standalone web application.

## Overview

This package contains the React frontend that:

- Provides the main user interface for video downloading
- Handles video URL input and processing
- Displays download progress and history
- Manages application settings and preferences
- Communicates with backend services via Socket.io
- Works in both Electron renderer and standalone web contexts

## Key Features

- **Video Download Interface**: Clean UI for adding and managing downloads
- **Real-time Updates**: Live progress tracking via Socket.io
- **Responsive Design**: Works on desktop and mobile devices
- **Theme Support**: Light/dark mode capabilities
- **Multi-platform**: Shared UI for Electron desktop and web versions
- **Settings Management**: User preferences and configuration

## Technologies

- **React 18**: Modern React with hooks and concurrent features
- **Vite**: Fast build tool and dev server
- **Ant Design**: UI component library
- **TailwindCSS**: Utility-first CSS framework
- **Shadcn/ui**: Modern component library
- **Zustand**: Lightweight state management
- **Socket.io Client**: Real-time communication
- **TypeScript**: Type-safe development

## Development

Run repository workflows from the repository root with Task v3.51.1 or newer
within the v3 release line. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for
installation and confirm it with `task --version` before starting.

```bash
# Install the Node workspace and pinned runtime tools
task setup

# Start the combined Electron + web development experience
task dev:all

# Start web-only development
task dev:web

# Start Electron-only development
task dev:electron

# Build the deployable Web product
task build:docker

# Validate changes
task check
task test
```

## Architecture

The frontend is designed to work in two contexts:

1. **Electron Renderer**: Loaded in Electron's BrowserWindow
2. **Standalone Web**: Embedded in and served directly by Go Core in Docker

It communicates with the backend services through Socket.io for real-time updates and HTTP APIs for data operations.
