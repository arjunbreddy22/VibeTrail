import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { simpleGit, SimpleGit } from 'simple-git';
import OpenAI from 'openai';

// Interface for commit metadata
interface CommitInfo {
  hash: string;
  timestamp: string;
  message: string;
  prompt: string;
  date: Date;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  fileDetails?: FileChangeDetail[];
  aiSummary?: string;
  aiRiskAnalysis?: string;
  aiSummaryLoading?: boolean;
}

interface FileChangeDetail {
  filename: string;
  linesAdded: number;
  linesRemoved: number;
  status: 'added' | 'modified' | 'deleted';
}

let shadowRepoPath: string;
let git: SimpleGit;
let openai: OpenAI | null = null;
let activeTimelinePanel: vscode.WebviewPanel | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('VibeTrail extension is now active!');
  
  // Initialize shadow Git repo on activation
  initializeShadowRepo();
  
  // Initialize OpenAI
  initializeOpenAI();
  
  // Register virtual file system provider
  const fileSystemProvider = new GitSnapshotFileSystemProvider(git);
  const fileSystemDisposable = vscode.workspace.registerFileSystemProvider('vibetrail', fileSystemProvider);
  
  // Listen for configuration changes
  const configChangeListener = vscode.workspace.onDidChangeConfiguration(async event => {
    if (event.affectsConfiguration('vibetrail.openaiApiKey')) {
      console.log('OpenAI API key configuration changed, reinitializing...');
      initializeOpenAI();
      
      // Refresh the timeline if it's open
      if (activeTimelinePanel) {
        const commits = await getCommitHistory();
        const hasApiKey = !!openai;
        activeTimelinePanel.webview.html = getWebviewContent(commits, hasApiKey);
        console.log('Timeline refreshed with new API key status:', hasApiKey);
      }
    }
  });
  
  // Register commands
  const saveSnapshotCommand = vscode.commands.registerCommand('vibetrail.saveSnapshot', () => saveSnapshot());
  const showTimelineCommand = vscode.commands.registerCommand('vibetrail.showTimeline', showTimeline);
  
  context.subscriptions.push(saveSnapshotCommand, showTimelineCommand, configChangeListener, fileSystemDisposable);
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
 * Initialize OpenAI client
 */
function initializeOpenAI() {
  try {
    const config = vscode.workspace.getConfiguration('vibetrail');
    const apiKey = config.get<string>('openaiApiKey');
    
    console.log('Initializing OpenAI with API key present:', !!apiKey);
    
    if (apiKey && apiKey.trim()) {
      openai = new OpenAI({
        apiKey: apiKey.trim()
      });
      console.log('OpenAI client initialized successfully');
    } else {
      openai = null;
      console.log('OpenAI API key not configured or empty');
    }
  } catch (error) {
    console.error('Error initializing OpenAI:', error);
    openai = null;
  }
}

/**
 * Save a snapshot of the current workspace
 */
async function saveSnapshot(prompt?: string) {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }
    
    // If no prompt provided, ask the user for one
    if (prompt === undefined) {
      prompt = await vscode.window.showInputBox({
        title: 'Save Snapshot',
        prompt: 'What are you working on? (optional)',
        placeHolder: 'e.g., "Before asking AI to refactor login" or leave empty',
        validateInput: (value) => {
          if (value.length > 200) {
            return 'Prompt must be 200 characters or less';
          }
          return null;
        }
      });
      
      // If user cancelled the input box, don't save
      if (prompt === undefined) {
        return;
      }
    }
    
    const workspacePath = workspaceFolder.uri.fsPath;
    
    // Copy all workspace files to shadow repo
    await copyWorkspaceFiles(workspacePath, shadowRepoPath);
    
    // Add all files to git
    await git.add('.');
    
    // Create commit with timestamp and optional prompt
    const timestamp = new Date().toISOString();
    const commitMessage = prompt && prompt.trim() 
      ? `${prompt.trim()} | Snapshot @ ${timestamp}`
      : `Snapshot @ ${timestamp}`;
    
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
    'Thumbs.db',
    'venv',
    'env',
    '.venv',
    '.env'
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
    const hasApiKey = !!openai;
    
    const panel = vscode.window.createWebviewPanel(
      'vibetrailTimeline',
      'VibeTrail Timeline',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    
    // Track the active panel
    activeTimelinePanel = panel;
    
    // Clean up when panel is disposed
    panel.onDidDispose(() => {
      activeTimelinePanel = null;
    });
    
    panel.webview.html = getWebviewContent(commits, hasApiKey);
    
    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'viewDiff':
            viewDiff(message.currentHash, message.previousHash);
            break;
          case 'viewFileDiff':
            viewFileDiff(message.filePath, message.currentHash, message.previousHash);
            break;
          case 'restore':
            restoreSnapshot(message.hash);
            break;
          case 'generateSummary':
            console.log('Received generateSummary command:', message);
            await handleGenerateSummary(panel, message.currentHash, message.previousHash);
            break;
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'vibetrail.openaiApiKey');
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
    
    const commits: CommitInfo[] = [];
    
    for (let i = 0; i < log.all.length; i++) {
      const commit = log.all[i];
      const previousCommit = log.all[i + 1];
      
      // Parse prompt from commit message if it exists
      const messageParts = commit.message.split(' | Snapshot @ ');
      const prompt = messageParts.length > 1 ? messageParts[0] : '';
      const timestamp = messageParts.length > 1 ? messageParts[1] : commit.date;
      
      // Analyze changes since previous commit
      let filesChanged = 0;
      let linesAdded = 0;
      let linesRemoved = 0;
      let fileDetails: FileChangeDetail[] = [];
      
      try {
        if (previousCommit) {
          // Get diff stats between this commit and previous
          const diffSummary = await git.diffSummary([previousCommit.hash, commit.hash]);
          
          filesChanged = diffSummary.files.length;
          linesAdded = diffSummary.insertions;
          linesRemoved = diffSummary.deletions;
          
          // Get file details
          fileDetails = diffSummary.files.map(file => {
            // Handle different file types - binary files don't have insertions/deletions
            const insertions = 'insertions' in file ? file.insertions : 0;
            const deletions = 'deletions' in file ? file.deletions : 0;
            
            return {
              filename: file.file,
              linesAdded: insertions,
              linesRemoved: deletions,
              status: insertions > 0 && deletions === 0 ? 'added' :
                     insertions === 0 && deletions > 0 ? 'deleted' : 'modified'
            };
          });
        }
      } catch (diffError) {
        console.warn('Could not analyze diff for commit:', commit.hash);
      }
      
      commits.push({
        hash: commit.hash,
        timestamp: commit.date,
        message: commit.message,
        prompt: prompt,
        date: new Date(commit.date),
        filesChanged,
        linesAdded,
        linesRemoved,
        fileDetails
      });
    }
    
    return commits;
  } catch (error) {
    console.error('Error getting commit history:', error);
    return [];
  }
}

/**
 * View diff between two commits using VS Code's built-in diff editor
 */
async function viewDiff(currentHash: string, previousHash: string) {
  try {
    // Get the list of changed files
    const diffSummary = await git.diffSummary([previousHash, currentHash]);
    const changedFiles = diffSummary.files;
    
    if (changedFiles.length === 0) {
      vscode.window.showInformationMessage('No changes between these snapshots');
      return;
    }
    
    // If only one file changed, show it directly
    if (changedFiles.length === 1) {
      await viewFileDiff(changedFiles[0].file, currentHash, previousHash);
      return;
    }
    
    // If multiple files changed, show a picker
    const fileItems = changedFiles.map(file => ({
      label: file.file,
      description: getFileChangeDescription(file),
      detail: `${('insertions' in file ? file.insertions : 0) || 0} additions, ${('deletions' in file ? file.deletions : 0) || 0} deletions`
    }));
    
    const selectedFile = await vscode.window.showQuickPick(fileItems, {
      placeHolder: 'Select a file to view diff',
      matchOnDescription: true
    });
    
    if (selectedFile) {
      await viewFileDiff(selectedFile.label, currentHash, previousHash);
    }
  } catch (error) {
    console.error('Error viewing diff:', error);
    vscode.window.showErrorMessage('Failed to view diff');
  }
}

/**
 * View diff for a specific file between two commits
 */
async function viewFileDiff(filePath: string, currentHash: string, previousHash: string) {
  try {
    const currentUri = vscode.Uri.parse(`vibetrail://${currentHash}/${filePath}`);
    const previousUri = vscode.Uri.parse(`vibetrail://${previousHash}/${filePath}`);
    
    const title = `${path.basename(filePath)} (${previousHash.substring(0, 8)} ↔ ${currentHash.substring(0, 8)})`;
    
    await vscode.commands.executeCommand(
      'vscode.diff',
      previousUri,
      currentUri,
      title
    );
  } catch (error) {
    console.error('Error viewing file diff:', error);
    vscode.window.showErrorMessage(`Failed to view diff for ${filePath}`);
  }
}

/**
 * Get a friendly description of file changes
 */
function getFileChangeDescription(file: any): string {
  const insertions = ('insertions' in file ? file.insertions : 0) || 0;
  const deletions = ('deletions' in file ? file.deletions : 0) || 0;
  
  if (insertions > 0 && deletions === 0) {
    return 'Added';
  } else if (insertions === 0 && deletions > 0) {
    return 'Deleted';
  } else if (insertions > 0 && deletions > 0) {
    return 'Modified';
  } else {
    return 'Changed';
  }
}

/**
 * Generate a friendly summary of changes for a commit
 */
function getChangeSummary(commit: CommitInfo): string {
  if (!commit.fileDetails || commit.fileDetails.length === 0) {
    return 'No specific changes detected';
  }
  
  const addedFiles = commit.fileDetails.filter(f => f.status === 'added');
  const modifiedFiles = commit.fileDetails.filter(f => f.status === 'modified');
  const deletedFiles = commit.fileDetails.filter(f => f.status === 'deleted');
  
  const parts: string[] = [];
  
  if (addedFiles.length > 0) {
    parts.push(`Added ${addedFiles.length} ${addedFiles.length === 1 ? 'file' : 'files'}`);
  }
  
  if (modifiedFiles.length > 0) {
    parts.push(`Modified ${modifiedFiles.length} ${modifiedFiles.length === 1 ? 'file' : 'files'}`);
  }
  
  if (deletedFiles.length > 0) {
    parts.push(`Deleted ${deletedFiles.length} ${deletedFiles.length === 1 ? 'file' : 'files'}`);
  }
  
  if (parts.length === 0) {
    return 'Files changed';
  }
  
  return parts.join(', ');
}

/**
 * Handle generating AI summary from webview
 */
async function handleGenerateSummary(panel: vscode.WebviewPanel, currentHash: string, previousHash: string) {
  console.log('handleGenerateSummary called');
  console.log('OpenAI client status:', !!openai);
  
  try {
    if (!openai) {
      console.log('No OpenAI client, showing error dialog');
      const result = await vscode.window.showErrorMessage(
        'OpenAI API key not configured. Would you like to set it up now?', 
        'Open Settings', 
        'Get API Key'
      );
      
      if (result === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'vibetrail.openaiApiKey');
      } else if (result === 'Get API Key') {
        vscode.env.openExternal(vscode.Uri.parse('https://platform.openai.com/api-keys'));
      }
      return;
    }

    console.log('Sending loading state to webview');
    // Show loading state in webview
    panel.webview.postMessage({
      command: 'updateSummaryState',
      hash: currentHash,
      loading: true
    });

    console.log('Generating AI summary...');
    // Generate the summary
    const { summary, riskAnalysis } = await generateAISummary(currentHash, previousHash);

    console.log('Sending results to webview');
    // Update webview with the results
    panel.webview.postMessage({
      command: 'updateSummaryState',
      hash: currentHash,
      loading: false,
      summary: summary,
      riskAnalysis: riskAnalysis
    });

  } catch (error) {
    console.error('Error handling AI summary:', error);
    
    // Show error in webview
    panel.webview.postMessage({
      command: 'updateSummaryState',
      hash: currentHash,
      loading: false,
      error: error instanceof Error ? error.message : 'Failed to generate AI summary'
    });

    vscode.window.showErrorMessage(`Failed to generate AI summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Generate AI summary and risk analysis for a commit
 */
async function generateAISummary(currentHash: string, previousHash: string): Promise<{summary: string, riskAnalysis: string}> {
  console.log('generateAISummary called with:', { currentHash: currentHash.substring(0, 8), previousHash: previousHash.substring(0, 8) });
  
  if (!openai) {
    throw new Error('OpenAI not configured. Please set your API key in settings.');
  }

  try {
    // Get the diff between commits
    console.log('Getting diff between commits...');
    const diffResult = await git.diff([`${previousHash}..${currentHash}`]);
    
    console.log('Diff result length:', diffResult.length);
    console.log('Diff preview:', diffResult.substring(0, 200) + '...');
    
    if (!diffResult || diffResult.trim().length === 0) {
      console.log('No changes detected in diff');
      return {
        summary: 'No changes detected',
        riskAnalysis: 'No risk - no changes were made'
      };
    }

    // Prepare the prompt for OpenAI
    const prompt = `You are a senior software engineer reviewing code changes. Please analyze this git diff and provide:

1. A concise summary (2-3 sentences) of what changed
2. A risk analysis (1-2 sentences) highlighting any potential issues

Git diff:
\`\`\`
${diffResult.slice(0, 8000)} ${diffResult.length > 8000 ? '... (truncated)' : ''}
\`\`\`

Please respond in this exact format:
SUMMARY: [Your summary here]
RISK: [Your risk analysis here]`;

    console.log('Sending request to OpenAI...');
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 300,
      temperature: 0.3
    });

    console.log('OpenAI response received');
    const content = response.choices[0]?.message?.content || '';
    console.log('OpenAI response content:', content);
    
    // Parse the response
    const summaryMatch = content.match(/SUMMARY:\s*(.+?)(?=RISK:|$)/s);
    const riskMatch = content.match(/RISK:\s*(.+?)$/s);
    
    const summary = summaryMatch?.[1]?.trim() || 'Unable to generate summary';
    const riskAnalysis = riskMatch?.[1]?.trim() || 'Unable to analyze risk';

    console.log('Parsed summary:', summary);
    console.log('Parsed risk analysis:', riskAnalysis);

    return { summary, riskAnalysis };
  } catch (error) {
    console.error('Error generating AI summary:', error);
    throw error;
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
function getWebviewContent(commits: CommitInfo[], hasApiKey: boolean = false): string {
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
                        .commit-prompt {
            font-style: italic;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 5px;
        }
        .commit-stats {
            display: flex;
            gap: 15px;
            margin: 8px 0;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        .stat-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .change-summary {
            font-size: 0.9em;
            color: var(--vscode-textLink-foreground);
            margin: 6px 0;
            font-style: italic;
        }
        .file-changes {
            margin-top: 10px;
            padding: 8px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            font-size: 0.8em;
        }
        .file-changes.collapsed {
            display: none;
        }
        .file-change-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 2px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .file-change-item:last-child {
            border-bottom: none;
        }
        .clickable-file {
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            transition: background-color 0.2s;
        }
        .clickable-file:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .file-status {
            font-size: 0.7em;
            padding: 2px 6px;
            border-radius: 3px;
            margin-right: 8px;
            font-weight: 500;
        }
        .file-status.added {
            background-color: rgba(40, 167, 69, 0.2);
            color: #28a745;
        }
        .file-status.modified {
            background-color: rgba(255, 193, 7, 0.2);
            color: #ffc107;
        }
        .file-status.deleted {
            background-color: rgba(220, 53, 69, 0.2);
            color: #dc3545;
        }
        .file-name {
            font-family: var(--vscode-editor-font-family);
            color: var(--vscode-textLink-foreground);
        }
        .file-stats {
            font-size: 0.75em;
            color: var(--vscode-descriptionForeground);
        }
        .lines-added {
            color: #28a745;
        }
        .lines-removed {
            color: #dc3545;
        }
        .toggle-files {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            font-size: 0.8em;
            padding: 2px 4px;
            margin-left: 8px;
        }
        .toggle-files:hover {
            text-decoration: underline;
        }
        .file-help-text {
            font-size: 0.75em;
            color: var(--vscode-descriptionForeground);
            margin-left: 12px;
            font-style: italic;
        }
        .ai-section {
            margin-top: 12px;
            padding: 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 6px;
            border-left: 3px solid var(--vscode-textLink-foreground);
        }
        .ai-section.hidden {
            display: none;
        }
        .ai-summary {
            margin-bottom: 8px;
        }
        .ai-summary-text {
            color: var(--vscode-foreground);
            font-size: 0.9em;
            line-height: 1.4;
            margin: 4px 0;
        }
        .ai-risk {
            margin-bottom: 8px;
        }
        .ai-risk-text {
            color: var(--vscode-errorForeground);
            font-size: 0.85em;
            line-height: 1.3;
            margin: 4px 0;
        }
        .ai-btn {
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.8em;
            font-weight: 500;
            margin-left: 8px;
        }
        .ai-btn:hover {
            background: linear-gradient(135deg, #5048e5, #7c3aed);
        }
        .ai-btn:disabled {
            background: #6b7280;
            cursor: not-allowed;
        }
        .ai-btn-disabled {
            background: #6b7280 !important;
            cursor: help !important;
            opacity: 0.8;
        }
        .ai-btn-disabled:hover {
            background: #374151 !important;
        }
        .ai-loading {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 0.85em;
        }
        .ai-error {
            color: var(--vscode-errorForeground);
            font-size: 0.85em;
        }
        .api-key-help {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 20px;
            border-left: 4px solid #6366f1;
        }
        .api-key-help h3 {
            margin: 0 0 8px 0;
            color: var(--vscode-foreground);
            font-size: 1em;
        }
        .api-key-help p {
            margin: 0 0 12px 0;
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
            line-height: 1.4;
        }
        .setup-btn {
            background: #6366f1;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
            font-weight: 500;
            margin-right: 8px;
        }
        .setup-btn:hover {
            background: #5048e5;
        }
        .learn-more-btn {
            background: transparent;
            color: var(--vscode-textLink-foreground);
            border: 1px solid var(--vscode-textLink-foreground);
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
            text-decoration: none;
        }
        .learn-more-btn:hover {
            background: var(--vscode-textLink-foreground);
            color: var(--vscode-editor-background);
        }
    </style>
</head>
<body>
    <h1>VibeTrail Timeline</h1>
    
    ${!hasApiKey ? `
        <div class="api-key-help">
            <h3>🤖 Unlock AI-Powered Change Analysis</h3>
            <p>VibeTrail can generate smart summaries and risk analysis of your code changes using AI. To enable this feature, you'll need to provide your own OpenAI API key.</p>
            <div style="background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: 4px; padding: 8px; margin: 8px 0; font-size: 0.85em; color: #333333;">
                <strong>⚠️ Important:</strong> Due to VS Code settings behavior, you need to set your API key in <em>both</em> User settings AND Workspace settings for it to work properly.
            </div>
            <button class="setup-btn" onclick="openSettings()">
                Set Up API Key
            </button>
            <a href="https://platform.openai.com/api-keys" class="learn-more-btn" target="_blank">
                Get API Key
            </a>
        </div>
    ` : ''}
    
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
                            <div style="display: flex; align-items: center; flex-wrap: wrap; margin-bottom: 8px;">
                                ${commit.prompt ? `<div class="commit-prompt">"${commit.prompt}"</div>` : ''}
                            </div>
                            
                            <div class="commit-message">${commit.prompt ? 'Snapshot' : commit.message}</div>
                            
                            <div class="commit-stats">
                                <div class="stat-item">
                                    <span>📄</span>
                                    <span>${commit.filesChanged} ${commit.filesChanged === 1 ? 'file' : 'files'} changed</span>
                                </div>
                                ${commit.linesAdded > 0 ? `
                                    <div class="stat-item lines-added">
                                        <span>+${commit.linesAdded} ${commit.linesAdded === 1 ? 'line' : 'lines'}</span>
                                    </div>
                                ` : ''}
                                ${commit.linesRemoved > 0 ? `
                                    <div class="stat-item lines-removed">
                                        <span>-${commit.linesRemoved} ${commit.linesRemoved === 1 ? 'line' : 'lines'}</span>
                                    </div>
                                ` : ''}
                            </div>
                            
                            ${commit.filesChanged > 0 ? `
                                <div class="change-summary">
                                    ${getChangeSummary(commit)}
                                </div>
                            ` : ''}
                            
                            <div class="commit-details">
                                <div>Hash: ${commit.hash.substring(0, 8)}</div>
                                <div>Date: ${new Date(commit.timestamp).toLocaleString()}</div>
                                ${commit.filesChanged > 0 ? `
                                    <button id="toggle-${commit.hash}" class="toggle-files" onclick="toggleFiles('${commit.hash}')">
                                        Show Files
                                    </button>
                                    <span class="file-help-text" id="help-${commit.hash}" style="display: none;">
                                        💡 Click on any file to view its diff
                                    </span>
                                ` : ''}
                            </div>
                            
                            ${commit.filesChanged > 0 ? `
                                <div id="files-${commit.hash}" class="file-changes collapsed">
                                    ${commit.fileDetails?.map(file => `
                                        <div class="file-change-item clickable-file" 
                                             onclick="viewFileDiff('${file.filename}', '${commit.hash}', '${index < commits.length - 1 ? commits[index + 1].hash : commit.hash}')">
                                            <div class="file-name">${file.filename}</div>
                                            <div class="file-stats">
                                                <span class="file-status ${file.status}">${file.status}</span>
                                                ${file.linesAdded > 0 ? `<span class="lines-added">+${file.linesAdded}</span>` : ''}
                                                ${file.linesRemoved > 0 ? `<span class="lines-removed">-${file.linesRemoved}</span>` : ''}
                                            </div>
                                        </div>
                                    `).join('') || ''}
                                </div>
                            ` : ''}
                        </div>
                        
                        <div class="commit-actions">
                            ${index < commits.length - 1 ? `
                                <button class="btn btn-secondary" onclick="viewDiff('${commit.hash}', '${commits[index + 1].hash}')">
                                    📊 View Changes
                                </button>
                            ` : ''}
                            <button class="btn" onclick="restore('${commit.hash}')">
                                🔄 Restore
                            </button>
                            ${index < commits.length - 1 ? `
                                <button class="ai-btn ${!hasApiKey ? 'ai-btn-disabled' : ''}" 
                                        onclick="${hasApiKey ? `generateSummary('${commit.hash}', '${commits[index + 1].hash}')` : 'showApiKeyHelp()'}"
                                        ${!hasApiKey ? 'title="API key required - click to configure"' : ''}>
                                    🤖 ${hasApiKey ? 'AI Summary' : 'AI Summary (API Key Required)'}
                                </button>
                            ` : ''}
                        </div>
                        
                        <div id="ai-${commit.hash}" class="ai-section hidden">
                            <div class="ai-loading" id="ai-loading-${commit.hash}" style="display: none;">
                                🤖 Analyzing changes...
                            </div>
                            <div class="ai-error" id="ai-error-${commit.hash}" style="display: none;">
                            </div>
                            <div class="ai-summary" id="ai-summary-${commit.hash}" style="display: none;">
                                <strong>📝 Summary:</strong>
                                <div class="ai-summary-text" id="ai-summary-text-${commit.hash}"></div>
                            </div>
                            <div class="ai-risk" id="ai-risk-${commit.hash}" style="display: none;">
                                <strong>⚠️ Risk Analysis:</strong>
                                <div class="ai-risk-text" id="ai-risk-text-${commit.hash}"></div>
                            </div>
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
        
        function viewFileDiff(filePath, currentHash, previousHash) {
            vscode.postMessage({
                command: 'viewFileDiff',
                filePath: filePath,
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
        
        function toggleFiles(commitHash) {
            const filesDiv = document.getElementById('files-' + commitHash);
            const toggleButton = document.getElementById('toggle-' + commitHash);
            const helpText = document.getElementById('help-' + commitHash);
            
            if (filesDiv.classList.contains('collapsed')) {
                filesDiv.classList.remove('collapsed');
                toggleButton.textContent = 'Hide Files';
                if (helpText) helpText.style.display = 'inline';
            } else {
                filesDiv.classList.add('collapsed');
                toggleButton.textContent = 'Show Files';
                if (helpText) helpText.style.display = 'none';
            }
        }
        
        function generateSummary(currentHash, previousHash) {
            vscode.postMessage({
                command: 'generateSummary',
                currentHash: currentHash,
                previousHash: previousHash
            });
        }
        
        function showApiKeyHelp() {
            if (confirm('To use AI summaries, you need to set up your OpenAI API key. Would you like to open settings now?')) {
                openSettings();
            }
        }
        
        function openSettings() {
            vscode.postMessage({
                command: 'openSettings'
            });
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateSummaryState') {
                const hash = message.hash;
                const aiSection = document.getElementById('ai-' + hash);
                const loadingDiv = document.getElementById('ai-loading-' + hash);
                const errorDiv = document.getElementById('ai-error-' + hash);
                const summaryDiv = document.getElementById('ai-summary-' + hash);
                const riskDiv = document.getElementById('ai-risk-' + hash);
                const summaryText = document.getElementById('ai-summary-text-' + hash);
                const riskText = document.getElementById('ai-risk-text-' + hash);
                
                // Show the AI section
                aiSection.classList.remove('hidden');
                
                if (message.loading) {
                    // Show loading state
                    loadingDiv.style.display = 'block';
                    errorDiv.style.display = 'none';
                    summaryDiv.style.display = 'none';
                    riskDiv.style.display = 'none';
                } else if (message.error) {
                    // Show error state
                    loadingDiv.style.display = 'none';
                    errorDiv.style.display = 'block';
                    errorDiv.textContent = '❌ ' + message.error;
                    summaryDiv.style.display = 'none';
                    riskDiv.style.display = 'none';
                } else {
                    // Show results
                    loadingDiv.style.display = 'none';
                    errorDiv.style.display = 'none';
                    summaryDiv.style.display = 'block';
                    riskDiv.style.display = 'block';
                    summaryText.textContent = message.summary;
                    riskText.textContent = message.riskAnalysis;
                }
            }
        });
    </script>
</body>
</html>`;
}

/**
 * Virtual file system provider for Git snapshots
 */
class GitSnapshotFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private git: SimpleGit) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const [commitHash, filePath] = this.parseUri(uri);
    
    try {
      // Check if file exists in the commit
      await this.git.show(`${commitHash}:${filePath}`);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: 0
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const [commitHash, filePath] = this.parseUri(uri);
    
    try {
      const content = await this.git.show(`${commitHash}:${filePath}`);
      return Buffer.from(content, 'utf8');
    } catch (error) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  private parseUri(uri: vscode.Uri): [string, string] {
    // URI format: vibetrail://commit-hash/file/path
    const commitHash = uri.authority;
    const filePath = uri.path.substring(1); // Remove leading slash
    return [commitHash, filePath];
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('Read-only file system');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Read-only file system');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Read-only file system');
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Read-only file system');
  }

  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions('Not supported');
  }
}

export function deactivate() {} 