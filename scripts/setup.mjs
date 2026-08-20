#!/usr/bin/env node
/**
 * Interactive setup wizard for terminal-agent.
 * Helps users configure their environment, AI coding agents, workspaces,
 * and Tailscale network settings with rich colored terminal output.
 *
 * Usage:
 *   npm run setup
 *   node scripts/setup.mjs [--defaults] [--yes]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const useDefaults = process.argv.includes('--defaults') || process.argv.includes('--yes') || !process.stdin.isTTY;

// ---------------------------------------------------------------- colors & formatting
const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR) || Boolean(process.env.FORCE_COLOR);

const c = {
  reset: (s) => (useColor ? `\x1b[0m${s}\x1b[0m` : String(s)),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[22m` : String(s)),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[22m` : String(s)),
  italic: (s) => (useColor ? `\x1b[3m${s}\x1b[23m` : String(s)),
  underline: (s) => (useColor ? `\x1b[4m${s}\x1b[24m` : String(s)),

  // colors
  black: (s) => (useColor ? `\x1b[30m${s}\x1b[39m` : String(s)),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[39m` : String(s)),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[39m` : String(s)),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[39m` : String(s)),
  blue: (s) => (useColor ? `\x1b[34m${s}\x1b[39m` : String(s)),
  magenta: (s) => (useColor ? `\x1b[35m${s}\x1b[39m` : String(s)),
  cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[39m` : String(s)),
  white: (s) => (useColor ? `\x1b[37m${s}\x1b[39m` : String(s)),
  gray: (s) => (useColor ? `\x1b[90m${s}\x1b[39m` : String(s)),

  // bright colors
  brightGreen: (s) => (useColor ? `\x1b[92m${s}\x1b[39m` : String(s)),
  brightCyan: (s) => (useColor ? `\x1b[96m${s}\x1b[39m` : String(s)),
  brightYellow: (s) => (useColor ? `\x1b[93m${s}\x1b[39m` : String(s)),
  brightBlue: (s) => (useColor ? `\x1b[94m${s}\x1b[39m` : String(s)),
  brightMagenta: (s) => (useColor ? `\x1b[95m${s}\x1b[39m` : String(s)),
  brightWhite: (s) => (useColor ? `\x1b[97m${s}\x1b[39m` : String(s)),

  // badges & UI helpers
  ok: (s) => (useColor ? `\x1b[92m✔\x1b[39m ${s}` : `✔ ${s}`),
  fail: (s) => (useColor ? `\x1b[31m✖\x1b[39m ${s}` : `✖ ${s}`),
  warn: (s) => (useColor ? `\x1b[93m⚠\x1b[39m ${s}` : `⚠ ${s}`),
  info: (s) => (useColor ? `\x1b[96mℹ\x1b[39m ${s}` : `ℹ ${s}`),
  bullet: (s) => (useColor ? `\x1b[96m➜\x1b[39m ${s}` : `➜ ${s}`),
};

function section(stepNum, totalSteps, title) {
  const badge = c.bold(c.brightCyan(` [${stepNum}/${totalSteps}] `));
  const heading = c.bold(c.brightWhite(title));
  const lineLen = Math.max(2, 60 - title.length - 8);
  const line = c.dim(c.cyan('─'.repeat(lineLen)));
  console.log(`\n${badge}${heading} ${line}\n`);
}

function resolveExecutable(command) {
  if (command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, command);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

function getTailscaleStatus() {
  try {
    const raw = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const status = JSON.parse(raw);
    const dnsName = (status.Self?.DNSName ?? '').replace(/\.$/, '');
    const user = status.Self?.UserID ? status.User?.[String(status.Self.UserID)]?.LoginName : null;
    return {
      running: status.BackendState === 'Running',
      dnsName: dnsName || null,
      user: user || null,
      httpsEnabled: Array.isArray(status.CertDomains) && status.CertDomains.length > 0,
    };
  } catch {
    return { running: false, dnsName: null, user: null, httpsEnabled: false };
  }
}

async function prompt(rl, questionText, defaultValue = '') {
  if (useDefaults) return defaultValue;
  const defaultDisplay = defaultValue ? c.dim(` [${c.cyan(defaultValue)}]`) : '';
  const display = `${c.bold(c.white(questionText))}${defaultDisplay}${c.cyan(': ')}`;
  return new Promise((resolve) => {
    rl.question(display, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue);
    });
  });
}

async function promptBool(rl, questionText, defaultVal = true) {
  if (useDefaults) return defaultVal;
  const suffix = defaultVal ? `${c.cyan('Y')}/n` : `y/${c.cyan('N')}`;
  const display = `${c.bold(c.white(questionText))} ${c.dim(`[${suffix}]`)}${c.cyan(': ')}`;
  return new Promise((resolve) => {
    rl.question(display, (answer) => {
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) {
        resolve(defaultVal);
        return;
      }
      resolve(trimmed === 'y' || trimmed === 'yes' || trimmed === '1' || trimmed === 'true');
    });
  });
}

async function main() {
  // Title Banner
  console.log(c.cyan('\n╭────────────────────────────────────────────────────────────────────────╮'));
  console.log(c.cyan('│  ') + c.bold(c.brightCyan('terminal-agent')) + c.dim(' : Personal Setup Wizard                               ') + c.cyan('│'));
  console.log(c.cyan('│  ') + c.brightWhite('Mobile-First Remote Development Console for AI Coding Agents          ') + c.cyan('│'));
  console.log(c.cyan('╰────────────────────────────────────────────────────────────────────────╯\n'));

  console.log(c.dim('This wizard configures:'));
  console.log(`  ${c.brightCyan('1.')} AI Coding CLI Agents ${c.gray('(Claude Code, Antigravity CLI)')}`);
  console.log(`  ${c.brightCyan('2.')} Local Server Port & Security`);
  console.log(`  ${c.brightCyan('3.')} Tailscale Tailnet Authentication`);
  console.log(`  ${c.brightCyan('4.')} Registered Workspace Repositories`);
  console.log(`  ${c.brightCyan('5.')} Environment Configuration ${c.gray('(.env)')}`);
  console.log(`  ${c.brightCyan('6.')} Project Build Verification\n`);

  // Check Node version
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 22) {
    console.log(c.warn(`Node.js 22 or newer is recommended (current: ${process.version}).`));
  } else {
    console.log(c.ok(`Node.js runtime: ${c.bold(process.version)}`));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // -----------------------------------------------------------
    // Step 1: Detect AI Agents
    // -----------------------------------------------------------
    section(1, 6, 'AI Coding Agents');

    const claudePath = resolveExecutable('claude');
    const agyPath = resolveExecutable('agy');

    if (claudePath) {
      console.log(`  ${c.ok(c.bold('Claude Code') + c.dim(` (claude)`))}`);
      console.log(`     ${c.gray('Location:')} ${c.dim(claudePath)}`);
    } else {
      console.log(`  ${c.fail(c.bold('Claude Code') + c.dim(` (claude) - not found on PATH`))}`);
    }

    if (agyPath) {
      console.log(`  ${c.ok(c.bold('Antigravity CLI') + c.dim(` (agy)`))}`);
      console.log(`     ${c.gray('Location:')} ${c.dim(agyPath)}`);
    } else {
      console.log(`  ${c.fail(c.bold('Antigravity CLI') + c.dim(` (agy) - not found on PATH`))}`);
    }

    let detectedAdapters = [];
    if (claudePath) detectedAdapters.push('claude-code');
    if (agyPath) detectedAdapters.push('antigravity-cli');

    if (detectedAdapters.length === 0) {
      detectedAdapters = ['claude-code', 'antigravity-cli'];
      console.log(`\n  ${c.info('No CLI binary found on PATH yet. Both adapters will be enabled in config.')}`);
    } else {
      console.log(`\n  ${c.info(`Detected agents: ${c.brightCyan(detectedAdapters.join(', '))}`)}`);
    }

    const adaptersChoice = await prompt(
      rl,
      'Enabled adapters (comma-separated: claude-code, antigravity-cli)',
      detectedAdapters.join(','),
    );
    const finalAdapters = adaptersChoice.split(',').map((s) => s.trim()).filter(Boolean);
    const defaultAdapterChoice = await prompt(
      rl,
      'Default adapter',
      finalAdapters[0] || 'claude-code',
    );

    // -----------------------------------------------------------
    // Step 2: Port and Host
    // -----------------------------------------------------------
    section(2, 6, 'Network & Port');
    const host = '127.0.0.1';
    console.log(`  ${c.info(`Host binding is locked to ${c.bold('127.0.0.1')} for Tailscale loopback isolation.`)}`);
    const port = await prompt(rl, 'Local server port', '4823');

    // -----------------------------------------------------------
    // Step 3: Tailscale Configuration
    // -----------------------------------------------------------
    section(3, 6, 'Tailscale Tailnet Authentication');
    const ts = getTailscaleStatus();
    let requireTsIdentity = false;
    let allowedUsers = '';

    if (ts.running) {
      console.log(`  ${c.ok('Tailscale is running on this machine.')}`);
      if (ts.dnsName) console.log(`     ${c.gray('MagicDNS host:')} ${c.bold(c.brightCyan(ts.dnsName))}`);
      if (ts.user) console.log(`     ${c.gray('Detected user:')} ${c.bold(c.brightGreen(ts.user))}`);
      console.log('');

      requireTsIdentity = await promptBool(
        rl,
        'Require Tailscale authentication headers (recommended when served via Tailscale)?',
        false,
      );

      if (requireTsIdentity && ts.user) {
        const restrictUser = await promptBool(
          rl,
          `Restrict access strictly to your Tailscale login (${c.cyan(ts.user)})?`,
          true,
        );
        if (restrictUser) allowedUsers = ts.user;
      }
    } else {
      console.log(`  ${c.warn('Tailscale is not currently active on this machine.')}`);
      console.log(`     ${c.dim('You can log in later with "tailscale up" and publish via "npm run serve:tailscale".')}`);
    }

    // -----------------------------------------------------------
    // Step 4: Workspaces
    // -----------------------------------------------------------
    section(4, 6, 'Workspace Repositories');
    const workspacesFilePath = path.join(root, 'workspaces.json');

    if (fs.existsSync(workspacesFilePath)) {
      console.log(`  ${c.ok(`Existing ${c.bold('workspaces.json')} found:`)}`);
      try {
        const parsed = JSON.parse(await fsp.readFile(workspacesFilePath, 'utf8'));
        for (const ws of parsed.workspaces ?? []) {
          console.log(`     ${c.bullet(c.bold(ws.name))} ${c.dim(`(${ws.id})`)} -> ${c.cyan(ws.path)} [${ws.enabled ? c.green('enabled') : c.yellow('disabled')}]`);
        }
      } catch {
        console.log(`     ${c.dim('(Could not parse existing workspaces.json)')}`);
      }
    } else {
      console.log(`  ${c.info('No workspaces.json found. Let\'s register your first repository.')}`);
      const defaultSample = '~/Code/my-project';
      const userProject = await prompt(
        rl,
        'Path to an existing repository/directory you want to manage',
        defaultSample,
      );

      const resolvedProject = userProject.startsWith('~/')
        ? path.join(os.homedir(), userProject.slice(2))
        : path.resolve(userProject);

      const exists = fs.existsSync(resolvedProject);
      const projectName = path.basename(resolvedProject) || 'my-project';
      const projectId = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 30) || 'default-repo';

      const workspacesConfig = {
        workspaces: [
          {
            id: projectId,
            name: projectName,
            path: userProject,
            enabled: exists,
          },
        ],
      };

      await fsp.writeFile(workspacesFilePath, JSON.stringify(workspacesConfig, null, 2) + '\n', 'utf8');
      console.log(`  ${c.ok(`Saved ${c.bold('workspaces.json')} (registered: ${c.cyan(projectId)} -> ${c.dim(userProject)})`)}`);
      if (!exists) {
        console.log(`     ${c.warn(`Note: Directory "${userProject}" does not exist yet; registered as disabled until created.`)}`);
      }
    }

    // -----------------------------------------------------------
    // Step 5: Write .env
    // -----------------------------------------------------------
    section(5, 6, 'Environment Configuration (.env)');
    const envFilePath = path.join(root, '.env');
    const envContent = [
      '# Generated by npm run setup',
      `HOST=${host}`,
      `PORT=${port}`,
      '',
      'WORKSPACES_FILE=workspaces.json',
      'STATE_DIR=.data',
      '',
      `REQUIRE_TAILSCALE_IDENTITY=${requireTsIdentity}`,
      `ALLOWED_TAILSCALE_USERS=${allowedUsers}`,
      '',
      `CLI_ADAPTERS=${finalAdapters.join(',')}`,
      `CLI_DEFAULT_ADAPTER=${defaultAdapterChoice}`,
      'CLI_PERMISSION_MODE=default',
      'PERMISSION_TIMEOUT_MS=900000',
      '',
      '# Optional binary/model overrides',
      '# CLAUDE_COMMAND=claude',
      '# CLAUDE_MODEL=',
      '# AGY_COMMAND=agy',
      '# AGY_MODEL=',
      '',
      '# Push notifications for the installed PWA. This is the only part of the',
      '# app that reaches the public internet (Apple/Google/Mozilla push services).',
      'PUSH_ENABLED=true',
      'PUSH_NOTIFY_TURN_FINISHED=true',
      'VAPID_SUBJECT=mailto:terminal-agent@localhost',
      '',
      'MAX_CONCURRENT_SESSIONS=4',
      'LOG_LEVEL=info',
      'LOG_PRETTY=false',
      '',
    ].join('\n');

    if (fs.existsSync(envFilePath)) {
      const overwrite = await promptBool(rl, '.env file already exists. Overwrite with new settings?', false);
      if (overwrite) {
        await fsp.writeFile(envFilePath, envContent, 'utf8');
        console.log(`  ${c.ok(`Updated ${c.bold('.env')}`)}`);
      } else {
        console.log(`  ${c.info(`Preserved existing ${c.bold('.env')}`)}`);
      }
    } else {
      await fsp.writeFile(envFilePath, envContent, 'utf8');
      console.log(`  ${c.ok(`Created ${c.bold('.env')}`)}`);
    }

    // -----------------------------------------------------------
    // Step 6: Build Server and Web Client
    // -----------------------------------------------------------
    section(6, 6, 'Build Verification');
    console.log(`  ${c.info('Compiling TypeScript server and web application...')}`);
    const buildResult = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
    if (buildResult.status !== 0) {
      console.log(`\n  ${c.fail('Build failed. Check compiler errors above.')}`);
    } else {
      console.log(`\n  ${c.ok(c.bold('Build succeeded!'))}`);
    }

    // -----------------------------------------------------------
    // Done! Next Steps
    // -----------------------------------------------------------
    console.log(c.brightGreen('\n╭────────────────────────────────────────────────────────────────────────╮'));
    console.log(c.brightGreen('│  ') + c.bold(c.brightWhite('✔ Setup Complete! Your console is ready to run.                       ')) + c.brightGreen('│'));
    console.log(c.brightGreen('╰────────────────────────────────────────────────────────────────────────╯\n'));

    console.log(c.bold('Next steps to access from your phone:\n'));
    console.log(`  ${c.brightCyan('1.')} Start the local server:`);
    console.log(`     ${c.bold(c.brightGreen('npm start'))}\n`);
    console.log(`  ${c.brightCyan('2.')} Publish via Tailscale Serve ${c.gray('(in a separate terminal)')}:`);
    console.log(`     ${c.bold(c.brightGreen('npm run serve:tailscale'))}\n`);
    console.log(`  ${c.brightCyan('3.')} Open the printed HTTPS URL on your phone and tap:`);
    console.log(`     ${c.yellow('Share → Add to Home Screen')} ${c.dim('(for a standalone full-screen web app)')}\n`);
    console.log(`  ${c.brightCyan('4.')} Launch it ${c.bold('from the new Home Screen icon')}, then tap the bell and`);
    console.log(`     turn notifications on ${c.dim('(iOS only delivers push to an installed app)')}\n`);

    console.log(c.dim('Background service options:'));
    console.log(`  • macOS launchd: ${c.cyan('deploy/com.terminal-agent.plist')}`);
    console.log(`  • Linux systemd: ${c.cyan('deploy/terminal-agent.service')}`);
    console.log(`  • Docker:        ${c.cyan('docker-compose.example.yml')}\n`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n${c.fail('Setup error:')}`, err.message);
  process.exit(1);
});

