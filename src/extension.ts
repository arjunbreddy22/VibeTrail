import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Type imports for development
type SimpleGit = any;
type OpenAI = any;

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
let isProUser: boolean = false;
let isInitialized: boolean = false;

// Lazy loading function for dependencies
async function ensureInitialized(): Promise<void> {
  if (isInitialized) {
    return;
  }

  try {
    console.log('VibeTrail: Initializing dependencies...');
    
    // Initialize shadow Git repo
    await initializeShadowRepo();
    
    // Initialize OpenAI
    await initializeOpenAI();
    
    isInitialized = true;
    console.log('VibeTrail: Dependencies initialized successfully');
  } catch (error) {
    console.error('VibeTrail: Failed to initialize dependencies:', error);
    throw error;
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('VibeTrail extension is now active!');
  
  // Register commands immediately without heavy initialization
  const saveSnapshotCommand = vscode.commands.registerCommand('vibetrail.saveSnapshot', async () => {
    try {
      await ensureInitialized();
      await saveSnapshot();
    } catch (error) {
      console.error('Error in saveSnapshot command:', error);
      vscode.window.showErrorMessage('Failed to initialize VibeTrail. Some features may not work properly.');
    }
  });
  
  const showTimelineCommand = vscode.commands.registerCommand('vibetrail.showTimeline', async () => {
    try {
      await ensureInitialized();
      await showTimeline();
    } catch (error) {
      console.error('Error in showTimeline command:', error);
      vscode.window.showErrorMessage('Failed to initialize VibeTrail. Some features may not work properly.');
    }
  });
  
  const repairRepoCommand = vscode.commands.registerCommand('vibetrail.repairRepository', async () => {
    try {
      const result = await vscode.window.showWarningMessage(
        'This will attempt to repair the VibeTrail repository by resetting its state. Continue?',
        'Yes',
        'No'
      );
      
      if (result === 'Yes') {
        await ensureInitialized();
        const repaired = await repairGitRepository();
        if (repaired) {
          vscode.window.showInformationMessage('VibeTrail repository repaired successfully');
        } else {
          vscode.window.showErrorMessage('Failed to repair VibeTrail repository');
        }
      }
    } catch (error) {
      console.error('Error in repairRepository command:', error);
      vscode.window.showErrorMessage('Failed to repair repository.');
    }
  });
  
  // Listen for configuration changes
  const configChangeListener = vscode.workspace.onDidChangeConfiguration(async event => {
    if (event.affectsConfiguration('vibetrail.openaiApiKey') || event.affectsConfiguration('vibetrail.proLicenseKey')) {
      console.log('VibeTrail configuration changed, reinitializing...');
      
      // Only reinitialize if we're already initialized
      if (isInitialized) {
        await initializeOpenAI();
        
        // Refresh the timeline if it's open
        if (activeTimelinePanel) {
          const commits = await getCommitHistory();
          const hasApiKey = !!openai;
          activeTimelinePanel.webview.html = getWebviewContent(commits, hasApiKey, isProUser);
          console.log('Timeline refreshed with new Pro status:', isProUser, 'API key status:', hasApiKey);
        }
      }
    }
  });
  
  context.subscriptions.push(saveSnapshotCommand, showTimelineCommand, repairRepoCommand, configChangeListener);
  
  // Deferred initialization: Initialize virtual file system provider when first needed
  let fileSystemProviderRegistered = false;
  const ensureFileSystemProvider = async () => {
    if (!fileSystemProviderRegistered && isInitialized) {
      const fileSystemProvider = new GitSnapshotFileSystemProvider(git);
      const fileSystemDisposable = vscode.workspace.registerFileSystemProvider('vibetrail', fileSystemProvider);
      context.subscriptions.push(fileSystemDisposable);
      fileSystemProviderRegistered = true;
      console.log('Virtual file system provider registered successfully');
    }
  };
  
  // Register the provider when we first need to view diffs
  context.subscriptions.push(vscode.commands.registerCommand('vibetrail.ensureFileSystemProvider', ensureFileSystemProvider));
}

/**
 * Initialize the shadow Git repository for the current workspace
 */
async function initializeShadowRepo() {
  try {
    // Lazy load simple-git
    const { simpleGit } = await import('simple-git');
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder open');
    }
    
    // Create a unique identifier for this workspace
    const workspacePath = workspaceFolder.uri.fsPath;
    const workspaceName = path.basename(workspacePath);
    
    // Create a safe directory name from the workspace path
    const workspaceHash = Buffer.from(workspacePath).toString('base64')
      .replace(/[/+=]/g, '_')
      .substring(0, 16);
    
    // Create shadow repo path specific to this workspace
    const homeDir = os.homedir();
    shadowRepoPath = path.join(homeDir, '.vibetrail', `${workspaceName}_${workspaceHash}`);
    
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
      console.log('Shadow Git repository initialized for workspace:', workspaceName, 'at:', shadowRepoPath);
    } else {
      console.log('Shadow Git repository already exists for workspace:', workspaceName, 'at:', shadowRepoPath);
      
      // Validate repository integrity
      const isHealthy = await validateRepositoryHealth();
      if (!isHealthy) {
        console.warn('Repository health check failed, but continuing...');
      }
    }
  } catch (error) {
    console.error('Error initializing shadow repository:', error);
    vscode.window.showErrorMessage('Failed to initialize VibeTrail shadow repository');
  }
}

/**
 * Validate the health of the Git repository
 */
async function validateRepositoryHealth(): Promise<boolean> {
  try {
    // Check if .git directory exists and is accessible
    const gitDir = path.join(shadowRepoPath, '.git');
    if (!fs.existsSync(gitDir)) {
      console.error('Git directory does not exist');
      return false;
    }
    
    // Verify we can read Git status
    await git.status();
    
    // Try to get at least one commit (if any exist)
    try {
      const log = await git.log({ maxCount: 1 });
      console.log(`Repository healthy: ${log.total} commits found`);
    } catch (logError) {
      // No commits yet is fine for a new repository
      console.log('Repository is empty (no commits), which is fine for new installations');
    }
    
    return true;
  } catch (error) {
    console.error('Repository health check failed:', error);
    return false;
  }
}

/**
 * Check if user has a valid Pro license
 */
function checkProLicense(): boolean {
  try {
    const config = vscode.workspace.getConfiguration('vibetrail');
    const licenseKey = config.get<string>('proLicenseKey');
    
    if (!licenseKey || !licenseKey.trim()) {
      return false;
    }
    
    // Simple license validation (you can make this more sophisticated)
    // For now, any non-empty key is considered valid
    // In production, you'd validate against your licensing server
    return licenseKey.trim().length > 10;
  } catch (error) {
    console.error('Error checking Pro license:', error);
    return false;
  }
}

/**
 * Initialize OpenAI client (only for Pro users)
 */
async function initializeOpenAI() {
  try {
    // Check Pro license first
    isProUser = checkProLicense();
    
    if (!isProUser) {
      openai = null;
      console.log('Pro license not found - AI features disabled');
      return;
    }
    
    const config = vscode.workspace.getConfiguration('vibetrail');
    const apiKey = config.get<string>('openaiApiKey');
    
    console.log('Initializing OpenAI for Pro user with API key present:', !!apiKey);
    
    if (apiKey && apiKey.trim()) {
      // Lazy load OpenAI
      const { default: OpenAI } = await import('openai');
      openai = new OpenAI({
        apiKey: apiKey.trim()
      });
      console.log('OpenAI client initialized successfully for Pro user');
    } else {
      openai = null;
      console.log('OpenAI API key not configured');
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
    
    // Pre-flight check: Validate repository health before saving
    const isHealthy = await validateRepositoryHealth();
    if (!isHealthy) {
      const shouldContinue = await vscode.window.showWarningMessage(
        'Repository health check failed. Continuing may risk data loss. Do you want to proceed?',
        'Proceed Anyway',
        'Cancel'
      );
      
      if (shouldContinue !== 'Proceed Anyway') {
        return;
      }
    }
    
    // If no prompt provided, ask the user for one
    if (prompt === undefined) {
      prompt = await vscode.window.showInputBox({
        title: 'Save Snapshot',
        prompt: 'What are you working on? (optional)',
        placeHolder: 'Enter your AI prompt or describe what you\'re doing, or leave empty'
      });
      
      // If user cancelled the input box, don't save
      if (prompt === undefined) {
        return;
      }
    }
    
    const workspacePath = workspaceFolder.uri.fsPath;
    
    // Copy all workspace files to shadow repo (with safety checks)
    await copyWorkspaceFiles(workspacePath, shadowRepoPath);
    
    // Add all files to git
    await git.add('.');
    
    // Create commit with timestamp and optional prompt
    const timestamp = new Date().toISOString();
    const commitMessage = prompt && prompt.trim() 
      ? `${prompt.trim()} | Snapshot @ ${timestamp}`
      : `Snapshot @ ${timestamp}`;
    
    await git.commit(commitMessage);
    
    // Post-save verification
    try {
      const latestCommit = await git.log({ maxCount: 1 });
      if (latestCommit.latest && latestCommit.latest.message === commitMessage) {
        console.log('Snapshot successfully verified');
      }
    } catch (verifyError) {
      console.warn('Could not verify snapshot was saved:', verifyError);
    }
    
    vscode.window.showInformationMessage(`Snapshot saved: ${commitMessage}`);
  } catch (error) {
    console.error('Error saving snapshot:', error);
    
    // Enhanced error reporting
    if (error instanceof Error) {
      if (error.message.includes('Git directory not found')) {
        vscode.window.showErrorMessage('Failed to save snapshot: Git repository corrupted. Try running "Repair Repository" command.');
      } else if (error.message.includes('not accessible')) {
        vscode.window.showErrorMessage('Failed to save snapshot: Git repository not accessible. Check file permissions.');
      } else {
        vscode.window.showErrorMessage(`Failed to save snapshot: ${error.message}`);
      }
    } else {
      vscode.window.showErrorMessage('Failed to save snapshot: Unknown error');
    }
  }
}

/**
 * Copy files from workspace to shadow repo, excluding common ignore patterns
 */
async function copyWorkspaceFiles(source: string, destination: string) {
  const ignorePatterns = [
    'node_modules',
    '.git',
    '.gitignore',
    '.gitattributes',
    '.gitmodules',
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
  
  // SAFETY CHECK: Validate Git repository before cleaning
  const gitDir = path.join(destination, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error('Git directory not found in destination. Aborting to prevent data loss.');
  }
  
  // Verify Git repository is accessible before proceeding
  try {
    const { simpleGit } = await import('simple-git');
    const tempGit = simpleGit(destination);
    await tempGit.status();
  } catch (error) {
    console.error('Git repository validation failed:', error);
    throw new Error('Git repository is not accessible. Aborting to prevent data loss.');
  }
  
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
  
  // SAFER CLEANUP: Clean destination directory (except .git) with additional safeguards
  const files = fs.readdirSync(destination);
  files.forEach(file => {
    // CRITICAL: Never touch .git directory
    if (file !== '.git') {
      const filePath = path.join(destination, file);
      try {
      if (fs.statSync(filePath).isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
        }
      } catch (cleanupError) {
        console.warn(`Failed to remove ${file} during cleanup:`, cleanupError);
        // Continue with other files even if one fails
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
    await ensureInitialized(); // Ensure dependencies are loaded
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
    
    panel.webview.html = getWebviewContent(commits, hasApiKey, isProUser);
    
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
          case 'openExternal':
            vscode.env.openExternal(vscode.Uri.parse(message.url));
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
    // Pre-check: Validate repository health
    const isHealthy = await validateRepositoryHealth();
    if (!isHealthy) {
      console.warn('Repository health check failed, returning empty history');
      return [];
    }
    
    const log = await git.log();
    
    if (!log || !log.all || log.all.length === 0) {
      console.log('No commits found in repository');
      return [];
    }
    
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
          
          if (diffSummary && diffSummary.files) {
          filesChanged = diffSummary.files.length;
            linesAdded = diffSummary.insertions || 0;
            linesRemoved = diffSummary.deletions || 0;
          
            // Get file details
  fileDetails = diffSummary.files.map((file: any) => {
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
        }
      } catch (diffError) {
        console.warn(`Could not analyze diff for commit ${commit.hash.substring(0, 8)}:`, diffError);
        // Continue with this commit but without diff stats
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
    
    console.log(`Successfully loaded ${commits.length} commits from history`);
    return commits;
  } catch (error) {
    console.error('Error getting commit history:', error);
    
    // Try to provide more specific error information
    if (error instanceof Error) {
      if (error.message.includes('not a git repository')) {
        console.error('Shadow repository is not a valid Git repository');
      } else if (error.message.includes('permission')) {
        console.error('Permission denied accessing Git repository');
      }
    }
    
    return [];
  }
}

/**
 * Repair Git repository state if corrupted
 */
async function repairGitRepository(): Promise<boolean> {
  try {
    console.log('Attempting to repair Git repository...');
    
    // First, check if the repository directory exists
    if (!fs.existsSync(shadowRepoPath)) {
      console.log('Shadow repository directory does not exist, recreating...');
      await initializeShadowRepo();
      return true;
    }
    
    // Check if .git directory exists
    const gitDir = path.join(shadowRepoPath, '.git');
    if (!fs.existsSync(gitDir)) {
      console.log('Git directory missing, reinitializing repository...');
      await git.init();
      console.log('Repository reinitialized successfully');
      return true;
    }
    
    // Try basic Git operations to test repository health
    try {
      await git.status();
      console.log('Repository status check passed');
    } catch (statusError) {
      console.warn('Repository status check failed, attempting to fix...');
      
      // Try to reinitialize if status fails
      try {
        await git.init();
        console.log('Repository reinitialized due to status failure');
      } catch (reinitError) {
        console.error('Failed to reinitialize repository:', reinitError);
        return false;
      }
    }
    
    // Reset to HEAD to clean up any uncommitted changes (only if we have commits)
    try {
      const log = await git.log({ maxCount: 1 });
      if (log.total > 0) {
        await git.reset(['--hard', 'HEAD']);
        console.log('Reset to HEAD completed');
      } else {
        console.log('No commits found, skipping reset');
      }
    } catch (resetError) {
      console.warn('Reset operation failed (this may be normal for empty repos):', resetError);
    }
    
    // Clean untracked files
    try {
      await git.clean('f', ['-d']);
      console.log('Cleaned untracked files');
    } catch (cleanError) {
      console.warn('Clean operation failed:', cleanError);
    }
    
    // Final verification
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      console.error('Repository is still not valid after repair attempt');
      return false;
    }
    
    // Test that we can perform basic operations
    try {
      await git.status();
      console.log('Final repository health check passed');
    } catch (finalError) {
      console.error('Final health check failed:', finalError);
      return false;
    }
    
    console.log('Git repository repaired successfully');
    return true;
  } catch (error) {
    console.error('Failed to repair Git repository:', error);
    
    // Last resort: try to completely reinitialize
    try {
      console.log('Attempting complete repository reinitialization...');
      if (fs.existsSync(shadowRepoPath)) {
        const gitDir = path.join(shadowRepoPath, '.git');
        if (fs.existsSync(gitDir)) {
          fs.rmSync(gitDir, { recursive: true, force: true });
        }
      }
      await initializeShadowRepo();
      console.log('Repository completely reinitialized');
      return true;
    } catch (lastResortError) {
      console.error('Complete reinitialization failed:', lastResortError);
      return false;
    }
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
    const fileItems = changedFiles.map((file: any) => ({
      label: file.file,
      description: getFileChangeDescription(file),
      detail: `${('insertions' in file ? file.insertions : 0) || 0} additions, ${('deletions' in file ? file.deletions : 0) || 0} deletions`
    }));
    
    const selectedFile = await vscode.window.showQuickPick(fileItems, {
      placeHolder: 'Select a file to view diff',
      matchOnDescription: true
    });
    
    if (selectedFile) {
      await viewFileDiff((selectedFile as any).label, currentHash, previousHash);
    }
  } catch (error) {
    console.error('Error viewing diff:', error);
    
    // Try to repair Git state if there's an error
    const repaired = await repairGitRepository();
    if (repaired) {
      vscode.window.showWarningMessage('Git repository was repaired. Please try viewing the diff again.');
    } else {
      vscode.window.showErrorMessage('Failed to view diff. The Git repository may be corrupted.');
    }
  }
}

/**
 * View diff for a specific file between two commits
 */
async function viewFileDiff(filePath: string, currentHash: string, previousHash: string) {
  try {
    // Ensure file system provider is registered for diff viewing
    await vscode.commands.executeCommand('vibetrail.ensureFileSystemProvider');
    console.log(`Viewing diff for ${filePath} between ${previousHash.substring(0, 8)} and ${currentHash.substring(0, 8)}`);
    
    // First check if the repository is valid
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      console.error('Git repository is not valid');
      vscode.window.showErrorMessage('VibeTrail repository is not valid. Try running the "Repair Repository" command.');
      return;
    }

    // Check if both commits exist
    try {
      await git.show(['--format=', currentHash]);
      console.log(`Current commit ${currentHash.substring(0, 8)} exists`);
    } catch (error) {
      console.error(`Current commit ${currentHash} not found:`, error);
      vscode.window.showErrorMessage(`Current snapshot ${currentHash.substring(0, 8)} not found. The repository may be corrupted.`);
      return;
    }

    try {
      await git.show(['--format=', previousHash]);
      console.log(`Previous commit ${previousHash.substring(0, 8)} exists`);
    } catch (error) {
      console.error(`Previous commit ${previousHash} not found:`, error);
      vscode.window.showErrorMessage(`Previous snapshot ${previousHash.substring(0, 8)} not found. The repository may be corrupted.`);
      return;
    }

    // Check file existence in both commits (this is optional - files can be added/deleted)
    let currentFileExists = false;
    let previousFileExists = false;
    
    try {
      await git.show(`${currentHash}:${filePath}`);
      currentFileExists = true;
      console.log(`File ${filePath} exists in current commit`);
    } catch (error) {
      console.log(`File ${filePath} not found in current commit ${currentHash} (might be deleted)`);
    }
    
    try {
      await git.show(`${previousHash}:${filePath}`);
      previousFileExists = true;
      console.log(`File ${filePath} exists in previous commit`);
    } catch (error) {
      console.log(`File ${filePath} not found in previous commit ${previousHash} (might be added)`);
    }

    // If file doesn't exist in either commit, that's an error
    if (!currentFileExists && !previousFileExists) {
      vscode.window.showErrorMessage(`File "${filePath}" not found in either snapshot. This might indicate a repository issue.`);
      return;
    }

    const currentUri = vscode.Uri.parse(`vibetrail://${currentHash}/${filePath}`);
    const previousUri = vscode.Uri.parse(`vibetrail://${previousHash}/${filePath}`);
    
    console.log(`Opening diff with URIs: ${previousUri.toString()} -> ${currentUri.toString()}`);
    
    const title = `${path.basename(filePath)} (${previousHash.substring(0, 8)} ↔ ${currentHash.substring(0, 8)})`;
    
    await vscode.commands.executeCommand(
      'vscode.diff',
      previousUri,
      currentUri,
      title
    );
    
    console.log('Diff command executed successfully');
  } catch (error) {
    console.error('Error viewing file diff:', error);
    
    // Try to repair Git state if there's an error
    const shouldRepair = await vscode.window.showErrorMessage(
      `Failed to view diff for ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}. Would you like to try repairing the repository?`,
      'Repair Repository',
      'Cancel'
    );
    
    if (shouldRepair === 'Repair Repository') {
      const repaired = await repairGitRepository();
      if (repaired) {
        vscode.window.showInformationMessage('Repository repaired. Please try viewing the diff again.');
      } else {
        vscode.window.showErrorMessage('Failed to repair repository. You may need to save a new snapshot.');
      }
    }
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
  console.log('Pro user status:', isProUser);
  
  try {
    // Check if user has Pro license first
    if (!isProUser) {
      console.log('Non-Pro user attempting to use AI features');
      const result = await vscode.window.showInformationMessage(
        '🤖 AI Summaries are a VibeTrail Pro feature. Upgrade to unlock AI-powered change analysis!',
        'Upgrade to Pro',
        'Learn More',
        'Maybe Later'
      );
      
      if (result === 'Upgrade to Pro') {
        vscode.env.openExternal(vscode.Uri.parse('https://vibetrail.dev/pro'));
      } else if (result === 'Learn More') {
        vscode.env.openExternal(vscode.Uri.parse('https://vibetrail.dev/features'));
      }
      return;
    }
    
    if (!openai) {
      console.log('Pro user but no OpenAI client');
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
    
    try {
    // Create temp directory
    fs.mkdirSync(tempPath, { recursive: true });
    
    // Clone shadow repo to temp directory
    const { simpleGit } = await import('simple-git');
    const tempGit = simpleGit();
    await tempGit.clone(shadowRepoPath, tempPath);
    
    // Checkout specific commit
    const tempRepoGit = simpleGit(tempPath);
    await tempRepoGit.checkout(hash);
    
      // Step 1: Clean the workspace (remove all files except ignored ones)
      await cleanWorkspace(workspacePath);
      
      // Step 2: Copy all files from snapshot to workspace
      await copySnapshotToWorkspace(tempPath, workspacePath);
      
      // Step 3: Synchronize shadow repository with restored workspace
      await synchronizeShadowRepo(workspacePath, hash);
    
    // Clean up temp directory
    fs.rmSync(tempPath, { recursive: true });
    
    vscode.window.showInformationMessage('Snapshot restored successfully');
    } catch (restoreError) {
      console.error('Error during restore operation:', restoreError);
      
      // Clean up temp directory if it exists
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
      
      // Try to recover Git state
      try {
        await git.reset(['--hard', 'HEAD']);
        await git.clean('f', ['-d']);
      } catch (recoveryError) {
        console.error('Error recovering Git state:', recoveryError);
      }
      
      throw restoreError;
    }
  } catch (error) {
    console.error('Error restoring snapshot:', error);
    vscode.window.showErrorMessage(`Failed to restore snapshot: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Synchronize the shadow repository with the current workspace state
 * This prevents deleted files from appearing in the next snapshot
 */
async function synchronizeShadowRepo(workspacePath: string, restoredCommitHash: string) {
  try {
    console.log('Synchronizing shadow repository with restored workspace...');
    
    // Step 1: Don't reset Git history - we want to maintain linear progression
    // Instead, we'll update the working directory to match the restored workspace
    
    // Step 2: Clean the shadow repository working directory (except .git)
    const shadowItems = fs.readdirSync(shadowRepoPath);
    for (const item of shadowItems) {
      if (item !== '.git') {
        const itemPath = path.join(shadowRepoPath, item);
        try {
          if (fs.statSync(itemPath).isDirectory()) {
            fs.rmSync(itemPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(itemPath);
          }
          console.log(`Removed from shadow repo: ${item}`);
        } catch (error) {
          console.warn(`Failed to remove ${item} from shadow repo:`, error);
        }
      }
    }
    
    // Step 3: Copy workspace files to shadow repo (exact match)
    await copyWorkspaceToShadowRepo(workspacePath, shadowRepoPath);
    
    // Step 4: Stage all changes (additions, modifications, deletions)
    await git.add('.');
    
    // Step 5: Create a commit that represents the restore operation
    const timestamp = new Date().toISOString();
    const commitMessage = `Restored to snapshot ${restoredCommitHash.substring(0, 8)} | Snapshot @ ${timestamp}`;
    
    try {
      await git.commit(commitMessage);
      console.log('Created restore commit to maintain clean history');
    } catch (commitError) {
      // If there are no changes to commit, that's fine
      if (commitError instanceof Error && commitError.message.includes('nothing to commit')) {
        console.log('No changes to commit after restore - workspace already matches shadow repo');
      } else {
        throw commitError;
      }
    }
    
    console.log('Shadow repository synchronized successfully');
  } catch (error) {
    console.error('Error synchronizing shadow repository:', error);
    // Don't throw here - restore was successful, this is just cleanup
    console.warn('Shadow repository sync failed, but restore was successful');
  }
}

/**
 * Copy workspace files to shadow repository (with consistent ignore patterns)
 */
async function copyWorkspaceToShadowRepo(workspacePath: string, shadowRepoPath: string) {
  const ignorePatterns = [
    'node_modules',
    '.git',
    '.gitignore',
    '.gitattributes',
    '.gitmodules',
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
    if (!fs.existsSync(src)) {
      return;
    }
    
    const stat = fs.statSync(src);
    
    if (stat.isDirectory()) {
      const dirName = path.basename(src);
      
      // Skip ignored directories
      if (ignorePatterns.includes(dirName)) {
        return;
      }
      
      // Create directory if it doesn't exist
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      
      // Copy all items in directory
      const items = fs.readdirSync(src);
      items.forEach(item => {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        copyRecursive(srcPath, destPath);
      });
    } else {
      const fileName = path.basename(src);
      
      // Skip ignored files
      if (ignorePatterns.some(pattern => fileName.includes(pattern))) {
        return;
      }
      
      // Copy file
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(src, dest);
    }
  };
  
  console.log('Copying workspace files to shadow repository...');
  
  // Copy all files from workspace to shadow repo (with ignore patterns)
  const items = fs.readdirSync(workspacePath);
  items.forEach(item => {
    if (item !== '.git') {
      const srcPath = path.join(workspacePath, item);
      const destPath = path.join(shadowRepoPath, item);
      copyRecursive(srcPath, destPath);
      console.log(`Copied to shadow repo: ${item}`);
    }
  });
  
  console.log('Workspace files copied to shadow repository successfully');
}

/**
 * Clean the workspace by removing all files except ignored ones
 */
async function cleanWorkspace(workspacePath: string) {
  const ignorePatterns = [
    'node_modules',
    '.git',
    '.gitignore',
    '.gitattributes',
    '.gitmodules',
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
  
  const shouldIgnore = (itemName: string): boolean => {
    return ignorePatterns.some(pattern => itemName.includes(pattern));
  };
  
  const cleanDirectory = (dirPath: string) => {
    if (!fs.existsSync(dirPath)) {
      return;
    }
    
    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      
      // Skip ignored items
      if (shouldIgnore(item)) {
        console.log(`Skipping ignored item during clean: ${item}`);
        continue;
      }
      
      try {
        const stat = fs.statSync(itemPath);
        
        if (stat.isDirectory()) {
          // Recursively remove directory
          fs.rmSync(itemPath, { recursive: true, force: true });
          console.log(`Removed directory: ${item}`);
        } else {
          // Remove file
          fs.unlinkSync(itemPath);
          console.log(`Removed file: ${item}`);
        }
      } catch (error) {
        console.warn(`Failed to remove ${item}:`, error);
        // Continue with other items even if one fails
      }
    }
  };
  
  console.log('Cleaning workspace before restore...');
  cleanDirectory(workspacePath);
  console.log('Workspace cleaned successfully');
}

/**
 * Copy files from snapshot to workspace
 */
async function copySnapshotToWorkspace(snapshotPath: string, workspacePath: string) {
  const copyRecursive = (src: string, dest: string) => {
    const stat = fs.statSync(src);
    
    if (stat.isDirectory()) {
      // Create directory if it doesn't exist
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      
      // Copy all items in directory
      const items = fs.readdirSync(src);
      items.forEach(item => {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        copyRecursive(srcPath, destPath);
      });
    } else {
      // Copy file
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(src, dest);
    }
  };
  
  console.log('Copying snapshot files to workspace...');
  
  // Copy all files from snapshot (excluding .git)
  const items = fs.readdirSync(snapshotPath);
  items.forEach(item => {
    if (item !== '.git') {
      const srcPath = path.join(snapshotPath, item);
      const destPath = path.join(workspacePath, item);
      copyRecursive(srcPath, destPath);
      console.log(`Copied: ${item}`);
    }
  });
  
  console.log('Snapshot files copied successfully');
}

/**
 * Generate HTML content for the webview
 */
function getWebviewContent(commits: CommitInfo[], hasApiKey: boolean = false, isProUser: boolean): string {
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
                        .prompt-container {
            margin-bottom: 12px;
        }
        .commit-prompt {
            font-style: italic;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 6px;
            line-height: 1.4;
            padding: 8px 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 6px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .commit-prompt.collapsed {
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
        .expand-prompt-btn {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            font-size: 0.8em;
            padding: 4px 8px;
            margin-top: 4px;
            border-radius: 4px;
            transition: background-color 0.2s;
        }
        .expand-prompt-btn:hover {
            background: var(--vscode-list-hoverBackground);
            text-decoration: underline;
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
        .ai-btn-pro-required {
            background: linear-gradient(135deg, #f59e0b, #d97706) !important;
            color: white !important;
            cursor: pointer !important;
            opacity: 1 !important;
            position: relative;
        }
        .ai-btn-pro-required:hover {
            background: linear-gradient(135deg, #d97706, #b45309) !important;
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(245, 158, 11, 0.3);
        }
        .ai-btn-pro-required::after {
            content: "✨";
            position: absolute;
            top: -2px;
            right: -2px;
            font-size: 0.7em;
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
    
    ${!isProUser ? `
        <div class="api-key-help">
            <h3>✨ Upgrade to VibeTrail Pro</h3>
            <p>Unlock AI-powered change analysis! Get smart summaries and risk analysis of your code changes with VibeTrail Pro.</p>
            <div style="background: #1e40af; border: 1px solid #3b82f6; border-radius: 4px; padding: 8px; margin: 8px 0; font-size: 0.85em; color: white;">
                <strong>🚀 Pro Features:</strong> AI summaries, risk analysis, and more coming soon!
            </div>
            <button class="setup-btn" onclick="vscode.postMessage({command: 'openExternal', url: 'https://vibetrail.dev/pro'})">
                Upgrade to Pro
            </button>
            <button class="learn-more-btn" onclick="vscode.postMessage({command: 'openExternal', url: 'https://vibetrail.dev/features'})">
                Learn More
            </button>
        </div>
    ` : (!hasApiKey ? `
        <div class="api-key-help">
            <h3>🤖 Configure AI Features</h3>
            <p>You have VibeTrail Pro! Set up your OpenAI API key to unlock AI-powered change analysis.</p>
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
    ` : '')}
    
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
                            ${commit.prompt ? `
<div class="prompt-container">
<div class="commit-prompt ${commit.prompt.length > 150 ? 'collapsed' : ''}" id="prompt-${commit.hash}">"${commit.prompt}"</div>
${commit.prompt.length > 150 ? `
<button class="expand-prompt-btn" id="expand-${commit.hash}" onclick="togglePrompt('${commit.hash}')">Show More</button>
` : ''}
</div>
                            ` : ''}
                            
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
                                ${isProUser ? `
                                <button class="ai-btn ${!hasApiKey ? 'ai-btn-disabled' : ''}" 
                                        onclick="${hasApiKey ? `generateSummary('${commit.hash}', '${commits[index + 1].hash}')` : 'showApiKeyHelp()'}"
                                        ${!hasApiKey ? 'title="API key required - click to configure"' : ''}>
                                        🤖 ${hasApiKey ? 'AI Summary' : 'AI Summary (API Key Required)'}
                                </button>
                                ` : `
                                    <button class="ai-btn ai-btn-pro-required" 
                                            onclick="showProUpgrade()"
                                            title="Upgrade to VibeTrail Pro to unlock AI-powered change analysis">
                                        🤖 AI Summary (Pro)
                                    </button>
                                `}
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
        
        function togglePrompt(commitHash) {
            const promptDiv = document.getElementById('prompt-' + commitHash);
            const expandButton = document.getElementById('expand-' + commitHash);
            
            if (promptDiv.classList.contains('collapsed')) {
                promptDiv.classList.remove('collapsed');
                expandButton.textContent = 'Show Less';
            } else {
                promptDiv.classList.add('collapsed');
                expandButton.textContent = 'Show More';
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

        function showProUpgrade() {
            if (confirm('🤖 AI Summaries are a VibeTrail Pro feature. Upgrade to unlock AI-powered change analysis! Would you like to upgrade now?')) {
                vscode.env.openExternal(vscode.Uri.parse('https://vibetrail.dev/pro'));
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
      // First check if the repository is valid
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        console.error('Git repository is not valid');
        throw vscode.FileSystemError.Unavailable('Git repository is not available');
      }

      // Check if commit exists
      try {
        await this.git.show(['--format=', commitHash]);
      } catch (commitError) {
        console.error(`Commit ${commitHash} not found:`, commitError);
        throw vscode.FileSystemError.FileNotFound(uri);
      }

      // Check if file exists in the commit
      const content = await this.git.show(`${commitHash}:${filePath}`);
      
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: Buffer.byteLength(content, 'utf8')
      };
    } catch (error) {
      console.error(`File not found in commit ${commitHash}: ${filePath}`, error);
      
      // If this is a specific Git error about the file not existing, that's expected for added/deleted files
      if (error instanceof Error && (
        error.message.includes('does not exist') || 
        error.message.includes('exists on disk, but not in') ||
        error.message.includes('Path') && error.message.includes('does not exist')
      )) {
        // For deleted files, we still want to show them as existing with empty content
        return {
          type: vscode.FileType.File,
          ctime: 0,
          mtime: 0,
          size: 0
        };
      }
      
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const [commitHash, filePath] = this.parseUri(uri);
    
    try {
      // First check if the repository is valid
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        console.error('Git repository is not valid');
        throw vscode.FileSystemError.Unavailable('Git repository is not available');
      }

      // Check if commit exists
      try {
        await this.git.show(['--format=', commitHash]);
      } catch (commitError) {
        console.error(`Commit ${commitHash} not found:`, commitError);
        throw vscode.FileSystemError.FileNotFound(uri);
      }

      const content = await this.git.show(`${commitHash}:${filePath}`);
      return Buffer.from(content, 'utf8');
    } catch (error) {
      console.error(`Failed to read file ${filePath} from commit ${commitHash}:`, error);
      
      // If this is a specific Git error about the file not existing, return empty content
      if (error instanceof Error && (
        error.message.includes('does not exist') || 
        error.message.includes('exists on disk, but not in') ||
        error.message.includes('Path') && error.message.includes('does not exist')
      )) {
        // Return empty content for deleted files
        return Buffer.from('', 'utf8');
      }
      
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  private parseUri(uri: vscode.Uri): [string, string] {
    // URI format: vibetrail://commit-hash/file/path
    const commitHash = uri.authority;
    const filePath = uri.path.substring(1); // Remove leading slash
    
    console.log(`Parsing URI: ${uri.toString()} -> commit: ${commitHash}, file: ${filePath}`);
    
    if (!commitHash || !filePath) {
      throw new Error(`Invalid URI format: ${uri.toString()}`);
    }
    
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