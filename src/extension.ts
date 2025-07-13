import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { simpleGit, SimpleGit } from 'simple-git';

// Interface for commit metadata
interface CommitInfo {
  hash: string;
  timestamp: string;
  message: string;
  date: Date;
}

let shadowRepoPath: string;
let git: SimpleGit;

export function activate(context: vscode.ExtensionContext) {
  console.log('VibeTrail extension is now active!');
  
  // Initialize shadow Git repo on activation
  initializeShadowRepo();
  
  // Register commands
  const saveSnapshotCommand = vscode.commands.registerCommand('vibetrail.saveSnapshot', saveSnapshot);
  const showTimelineCommand = vscode.commands.registerCommand('vibetrail.showTimeline', showTimeline);
  
  context.subscriptions.push(saveSnapshotCommand, showTimelineCommand);
}

/**
 * Initialize the shadow Git repository at ~/.vibetrail/
 */
async function initializeShadowRepo() {
  try {
    // Create shadow repo path in user's home directory
    const homeDir = os.homedir();
    shadowRepoPath = path.join(homeDir, '.vibetrail');
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(shadowRepoPath)) {
      fs.mkdirSync(shadowRepoPath, { recursive: true });
    }
    
    // Initialize Git repository
    git = simpleGit(shadowRepoPath);
    
    // Check if already initialized
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      await git.init();
      console.log('Shadow Git repository initialized at:', shadowRepoPath);
    } else {
      console.log('Shadow Git repository already exists at:', shadowRepoPath);
    }
  } catch (error) {
    console.error('Error initializing shadow repository:', error);
    vscode.window.showErrorMessage('Failed to initialize VibeTrail shadow repository');
  }
}

/**
 * Save a snapshot of the current workspace
 */
async function saveSnapshot() {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }
    
    const workspacePath = workspaceFolder.uri.fsPath;
    
    // Copy all workspace files to shadow repo
    await copyWorkspaceFiles(workspacePath, shadowRepoPath);
    
    // Add all files to git
    await git.add('.');
    
    // Create commit with timestamp
    const timestamp = new Date().toISOString();
    const commitMessage = `Snapshot @ ${timestamp}`;
    
    await git.commit(commitMessage);
    
    vscode.window.showInformationMessage(`Snapshot saved: ${commitMessage}`);
  } catch (error) {
    console.error('Error saving snapshot:', error);
    vscode.window.showErrorMessage('Failed to save snapshot');
  }
}

/**
 * Copy files from workspace to shadow repo, excluding common ignore patterns
 */
async function copyWorkspaceFiles(source: string, destination: string) {
  const ignorePatterns = [
    'node_modules',
    '.git',
    '.vscode',
    'out',
    'dist',
    'build',
    '.DS_Store',
    'Thumbs.db'
  ];
  
  const copyRecursive = (src: string, dest: string) => {
    const stat = fs.statSync(src);
    
    if (stat.isDirectory()) {
      const dirName = path.basename(src);
      
      // Skip ignored directories
      if (ignorePatterns.includes(dirName)) {
        return;
      }
      
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      
      const files = fs.readdirSync(src);
      files.forEach(file => {
        const srcPath = path.join(src, file);
        const destPath = path.join(dest, file);
        copyRecursive(srcPath, destPath);
      });
    } else {
      const fileName = path.basename(src);
      
      // Skip ignored files
      if (ignorePatterns.some(pattern => fileName.includes(pattern))) {
        return;
      }
      
      fs.copyFileSync(src, dest);
    }
  };
  
  // Clean destination directory (except .git)
  const files = fs.readdirSync(destination);
  files.forEach(file => {
    if (file !== '.git') {
      const filePath = path.join(destination, file);
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true });
      } else {
        fs.unlinkSync(filePath);
      }
    }
  });
  
  // Copy workspace files
  const workspaceFiles = fs.readdirSync(source);
  workspaceFiles.forEach(file => {
    const srcPath = path.join(source, file);
    const destPath = path.join(destination, file);
    copyRecursive(srcPath, destPath);
  });
}

/**
 * Show the timeline webview panel
 */
async function showTimeline() {
  try {
    const commits = await getCommitHistory();
    
    const panel = vscode.window.createWebviewPanel(
      'vibetrailTimeline',
      'VibeTrail Timeline',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    
    panel.webview.html = getWebviewContent(commits);
    
    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
      message => {
        switch (message.command) {
          case 'viewDiff':
            viewDiff(message.currentHash, message.previousHash);
            break;
          case 'restore':
            restoreSnapshot(message.hash);
            break;
        }
      }
    );
  } catch (error) {
    console.error('Error showing timeline:', error);
    vscode.window.showErrorMessage('Failed to load timeline');
  }
}

/**
 * Get commit history from shadow repo
 */
async function getCommitHistory(): Promise<CommitInfo[]> {
  try {
    const log = await git.log();
    
    return log.all.map(commit => ({
      hash: commit.hash,
      timestamp: commit.date,
      message: commit.message,
      date: new Date(commit.date)
    }));
  } catch (error) {
    console.error('Error getting commit history:', error);
    return [];
  }
}

/**
 * View diff between two commits
 */
async function viewDiff(currentHash: string, previousHash: string) {
  try {
    const diffResult = await git.diff([`${previousHash}..${currentHash}`]);
    
    const doc = await vscode.workspace.openTextDocument({
      content: diffResult,
      language: 'diff'
    });
    
    await vscode.window.showTextDocument(doc);
  } catch (error) {
    console.error('Error viewing diff:', error);
    vscode.window.showErrorMessage('Failed to view diff');
  }
}

/**
 * Restore a snapshot to the current workspace
 */
async function restoreSnapshot(hash: string) {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }
    
    const result = await vscode.window.showWarningMessage(
      'This will replace all files in your workspace with the selected snapshot. Are you sure?',
      'Yes',
      'No'
    );
    
    if (result !== 'Yes') {
      return;
    }
    
    const workspacePath = workspaceFolder.uri.fsPath;
    const tempPath = path.join(os.tmpdir(), 'vibetrail-restore-' + Date.now());
    
    // Create temp directory
    fs.mkdirSync(tempPath, { recursive: true });
    
    // Clone shadow repo to temp directory
    const tempGit = simpleGit();
    await tempGit.clone(shadowRepoPath, tempPath);
    
    // Checkout specific commit
    const tempRepoGit = simpleGit(tempPath);
    await tempRepoGit.checkout(hash);
    
    // Copy files from temp to workspace (excluding .git)
    const files = fs.readdirSync(tempPath);
    files.forEach(file => {
      if (file !== '.git') {
        const srcPath = path.join(tempPath, file);
        const destPath = path.join(workspacePath, file);
        
        if (fs.statSync(srcPath).isDirectory()) {
          fs.rmSync(destPath, { recursive: true, force: true });
          fs.cpSync(srcPath, destPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    });
    
    // Clean up temp directory
    fs.rmSync(tempPath, { recursive: true });
    
    vscode.window.showInformationMessage('Snapshot restored successfully');
  } catch (error) {
    console.error('Error restoring snapshot:', error);
    vscode.window.showErrorMessage('Failed to restore snapshot');
  }
}

/**
 * Generate HTML content for the webview
 */
function getWebviewContent(commits: CommitInfo[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VibeTrail Timeline</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .timeline {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .commit {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 15px;
            background: var(--vscode-editor-background);
        }
        .commit-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .commit-info {
            display: flex;
            flex-direction: column;
        }
        .commit-message {
            font-weight: bold;
            margin-bottom: 5px;
        }
        .commit-details {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }
        .commit-actions {
            display: flex;
            gap: 10px;
        }
        .btn {
            padding: 6px 12px;
            border: 1px solid var(--vscode-button-border);
            border-radius: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
            font-size: 0.85em;
        }
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <h1>VibeTrail Timeline</h1>
    
    ${commits.length === 0 ? `
        <div class="empty-state">
            <p>No snapshots yet. Use the "Save Snapshot" command to create your first snapshot.</p>
        </div>
    ` : `
        <div class="timeline">
            ${commits.map((commit, index) => `
                <div class="commit">
                    <div class="commit-header">
                        <div class="commit-info">
                            <div class="commit-message">${commit.message}</div>
                            <div class="commit-details">
                                <div>Hash: ${commit.hash.substring(0, 8)}</div>
                                <div>Date: ${new Date(commit.timestamp).toLocaleString()}</div>
                            </div>
                        </div>
                        <div class="commit-actions">
                            ${index < commits.length - 1 ? `
                                <button class="btn btn-secondary" onclick="viewDiff('${commit.hash}', '${commits[index + 1].hash}')">
                                    View Diff
                                </button>
                            ` : ''}
                            <button class="btn" onclick="restore('${commit.hash}')">
                                Restore
                            </button>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
    `}
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function viewDiff(currentHash, previousHash) {
            vscode.postMessage({
                command: 'viewDiff',
                currentHash: currentHash,
                previousHash: previousHash
            });
        }
        
        function restore(hash) {
            vscode.postMessage({
                command: 'restore',
                hash: hash
            });
        }
    </script>
</body>
</html>`;
}

export function deactivate() {} 