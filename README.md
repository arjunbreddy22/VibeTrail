# VibeTrail: Your Personal Coding Journey Tracker

![Version](https://img.shields.io/badge/version-0.0.1-blue)


**VibeTrail is a Visual Studio Code extension that automatically tracks your coding progress by creating snapshots of your workspace. It’s like a personal time machine for your code, allowing you to look back at your work without cluttering your main Git history.**

Whether you're experimenting with a new feature, refactoring a complex module, or just want a private record of your daily progress, VibeTrail has you covered.

## ✨ Key Features

- 🏠 **Shadow Repository**: VibeTrail creates a hidden Git repository in your home directory (`~/.vibetrail/`) to store your snapshots, keeping your project's primary repository clean.
- 📸 **Effortless Snapshots**: Save a complete snapshot of your workspace with a single command. Add a message to remember what you were working on.
- 📚 **Interactive Timeline**: Browse your snapshots in a beautiful and intuitive timeline view. See every change you've made in chronological order.
- 🔍 **Visual Diff Viewer**: Compare any two snapshots to see exactly what changed. The color-coded diff view makes it easy to spot additions, modifications, and deletions.
- 🔄 **One-Click Restore**: Instantly restore your entire workspace to any previous snapshot. It's a safe and easy way to undo changes or go back to a known good state.
- 🤖 **AI-Powered Analysis (Optional)**:
  - **Smart Summaries**: Let AI generate concise, human-readable summaries of the changes between snapshots.
  - **Risk Assessment**: Get an AI-powered analysis of potential risks or issues in your code changes.

## 🚀 Getting Started

1.  **Install Dependencies**:
    ```bash
    npm install
    ```
2.  **Compile the Extension**:
    ```bash
    npm run compile
    ```
3.  **Run in VS Code**:
    - Press `F5` to open a new Extension Development Host window.
    - Open any workspace to start using VibeTrail.

## 💻 How to Use

1.  **Open the Command Palette**: `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac).
2.  **Save a Snapshot**:
    - Run the **`VibeTrail: Save Snapshot`** command.
    - Enter an optional message to describe your work (e.g., "Before refactoring the login page").
3.  **View Your Timeline**:
    - Run the **`VibeTrail: Show Timeline`** command.
    - In the timeline, you can:
      - **View Diffs**: See the changes between any two snapshots.
      - **Restore**: Revert your workspace to a previous state.
      - **Generate AI Summaries**: Get AI-powered insights into your changes (requires configuration).

## ⚙️ Configuration

To enable the AI-powered features, you need to provide an OpenAI API key:

1.  **Get an API Key**: If you don't have one, you can get a key from the [OpenAI Platform](https://platform.openai.com/api-keys).
2.  **Open VS Code Settings**: Go to **File > Preferences > Settings** (or `Ctrl+,`).
3.  **Set the API Key**:
    - Search for **`VibeTrail`**.
    - In the **`VibeTrail: OpenAI API Key`** field, enter your API key.
    - **Important**: For the best experience, set the API key in both your **User** and **Workspace** settings.

## 📁 What Gets Tracked

VibeTrail is smart about what it tracks. It ignores common development files and directories, including:

- `node_modules/`
- `.git/`
- `.vscode/`
- `out/`, `dist/`, `build/`
- `.DS_Store`, `Thumbs.db`

## 🤝 Contributing

We welcome contributions! To get started:

1.  Clone this repository.
2.  Install dependencies: `npm install`.
3.  Start the watch mode to automatically recompile on changes: `npm run watch`.
4.  Press `F5` to launch the extension in a new VS Code window.

## 📄 License

This project is proprietary and closed-source. All rights are reserved.

For licensing information, please contact us at [your-email@example.com](mailto:your-email@example.com).
