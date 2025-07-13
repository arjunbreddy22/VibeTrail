# VibeTrail VS Code Extension

**Track your coding journey with automatic workspace snapshots**

VibeTrail is a VS Code extension that creates a shadow Git repository to track snapshots of your workspace over time. Perfect for keeping a history of your coding progress without cluttering your main Git repository.

## Features

- 🏠 **Shadow Repository**: Creates a hidden Git repository at `~/.vibetrail/` to store your snapshots
- 📸 **Easy Snapshots**: Save workspace snapshots with a single command
- 📚 **Timeline View**: Browse all your snapshots in a beautiful timeline interface
- 🔍 **Diff Viewer**: Compare changes between snapshots
- 🔄 **Restore Functionality**: Restore any previous snapshot to your workspace

## Commands

- **VibeTrail: Save Snapshot** - Captures current workspace state and creates a commit
- **VibeTrail: Show Timeline** - Opens the timeline view to browse all snapshots

## How It Works

1. **Activation**: On first use, VibeTrail creates a hidden Git repository at `~/.vibetrail/`
2. **Snapshots**: When you save a snapshot, it copies your workspace files (excluding common ignore patterns) to the shadow repo and creates a Git commit
3. **Timeline**: View all your snapshots in chronological order with timestamps and commit hashes
4. **Diff View**: Compare any two snapshots to see what changed
5. **Restore**: Restore any previous snapshot back to your workspace

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Compile the extension:
   ```bash
   npm run compile
   ```

3. Press `F5` to run the extension in a new Extension Development Host window

## Usage

1. Open any workspace in VS Code
2. Use `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) to open the command palette
3. Run "VibeTrail: Save Snapshot" to create your first snapshot
4. Run "VibeTrail: Show Timeline" to view all snapshots
5. In the timeline, use "View Diff" to see changes or "Restore" to restore a snapshot

## What Gets Tracked

VibeTrail tracks all files in your workspace except:
- `node_modules/`
- `.git/`
- `.vscode/`
- `out/`, `dist/`, `build/`
- `.DS_Store`, `Thumbs.db`

## Development

To contribute to VibeTrail:

1. Clone the repository
2. Install dependencies: `npm install`
3. Start the watch mode: `npm run watch`
4. Press `F5` to launch the extension

## License

MIT License - see LICENSE file for details 