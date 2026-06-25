#!/usr/bin/env tsx

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  executeHook,
  logInfo,
  logDebug,
  logError,
  isCI,
  toError,
} from '../utils/index.js';
import type { NotificationInput } from '../types/index.js';

const execFileAsync = promisify(execFile);

interface NotificationConfig {
  desktop: boolean;
  console: boolean;
  enableInCI: boolean;
  customCommand?: string;
  slackWebhook?: string;
  email?: {
    to: string;
    from?: string;
    smtp?: string;
  };
}

interface NotificationData {
  title: string;
  message: string;
  priority: 'low' | 'normal' | 'high';
  icon: string;
}

function getNotificationConfig(): NotificationConfig {
  return {
    desktop: process.env['CLAUDE_HOOK_DESKTOP_NOTIFICATIONS'] !== 'false',
    console: process.env['CLAUDE_HOOK_CONSOLE_NOTIFICATIONS'] !== 'false',
    enableInCI: process.env['CLAUDE_HOOK_NOTIFICATIONS_IN_CI'] === 'true',
    ...(process.env['CLAUDE_HOOK_NOTIFICATION_COMMAND'] && {
      customCommand: process.env['CLAUDE_HOOK_NOTIFICATION_COMMAND'],
    }),
    ...(process.env['CLAUDE_HOOK_SLACK_WEBHOOK'] && {
      slackWebhook: process.env['CLAUDE_HOOK_SLACK_WEBHOOK'],
    }),
    ...((): Partial<Pick<NotificationConfig, 'email'>> => {
      const emailTo = process.env['CLAUDE_HOOK_EMAIL_TO'];
      if (!emailTo) return {};
      return {
        email: {
          to: emailTo,
          from:
            process.env['CLAUDE_HOOK_EMAIL_FROM'] ?? 'claude-code@localhost',
          ...(process.env['CLAUDE_HOOK_SMTP_SERVER'] && {
            smtp: process.env['CLAUDE_HOOK_SMTP_SERVER'],
          }),
        },
      };
    })(),
  };
}

async function handleNotification(input: NotificationInput): Promise<void> {
  const { message, notification_type } = input;
  const config = getNotificationConfig();

  logInfo(
    `Notification received: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`
  );

  if (isCI() && !config.enableInCI) {
    logDebug('Skipping notification in CI environment');
    return;
  }

  const notificationType = classifyNotification(message, notification_type);
  const notification = {
    title: getNotificationTitle(notificationType),
    message: formatNotificationMessage(message, notificationType),
    priority: getNotificationPriority(notificationType),
    icon: getNotificationIcon(notificationType),
  };

  logDebug('Notification details', notification);

  const promises: Promise<void>[] = [];

  if (config.console) {
    promises.push(sendConsoleNotification(notification));
  }

  if (config.desktop) {
    promises.push(sendDesktopNotification(notification));
  }

  if (config.customCommand) {
    promises.push(sendCustomNotification(notification, config.customCommand));
  }

  if (config.slackWebhook) {
    promises.push(sendSlackNotification(notification, config.slackWebhook));
  }

  if (config.email) {
    promises.push(sendEmailNotification(notification, config.email));
  }

  try {
    await Promise.all(promises);
    logDebug('All notifications sent successfully');
  } catch (error) {
    logError('Some notifications failed to send', toError(error));
  }
}

function classifyNotification(
  message: string,
  notificationType?: NotificationInput['notification_type']
): 'permission' | 'waiting' | 'error' | 'info' {
  switch (notificationType) {
    case 'permission_prompt':
      return 'permission';
    case 'idle_prompt':
    case 'elicitation_dialog':
    case 'elicitation_response':
      return 'waiting';
    case 'auth_success':
    case 'elicitation_complete':
      return 'info';
    case undefined:
      break;
    default:
      return assertNeverNotificationType(notificationType);
  }

  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('permission') || lowerMessage.includes('approve')) {
    return 'permission';
  }

  if (lowerMessage.includes('waiting') || lowerMessage.includes('input')) {
    return 'waiting';
  }

  if (lowerMessage.includes('error') || lowerMessage.includes('failed')) {
    return 'error';
  }

  return 'info';
}

function assertNeverNotificationType(
  notificationType: never
): 'permission' | 'waiting' | 'error' | 'info' {
  throw new Error(`Unhandled notification type: ${String(notificationType)}`);
}

function getNotificationTitle(type: string): string {
  switch (type) {
    case 'permission':
      return '🔐 Claude Code - Permission Required';
    case 'waiting':
      return '⏳ Claude Code - Waiting for Input';
    case 'error':
      return '❌ Claude Code - Error';
    case 'info':
    default:
      return '🤖 Claude Code - Notification';
  }
}

function formatNotificationMessage(message: string, type: string): string {
  if (message.length > 200) {
    message = message.substring(0, 197) + '...';
  }

  switch (type) {
    case 'permission':
      return `${message}\n\nClick to return to Claude Code.`;
    case 'waiting':
      return `${message}\n\nClick to continue your session.`;
    case 'error':
      return `${message}\n\nCheck Claude Code for details.`;
    default:
      return message;
  }
}

function getNotificationPriority(type: string): 'low' | 'normal' | 'high' {
  switch (type) {
    case 'permission':
    case 'error':
      return 'high';
    case 'waiting':
      return 'normal';
    default:
      return 'low';
  }
}

function getNotificationIcon(type: string): string {
  switch (type) {
    case 'permission':
      return '🔐';
    case 'waiting':
      return '⏳';
    case 'error':
      return '❌';
    default:
      return '🤖';
  }
}

async function sendConsoleNotification(
  notification: NotificationData
): Promise<void> {
  const timestamp = new Date().toISOString();
  const formattedMessage = `\n${'='.repeat(60)}\n${notification.icon} ${notification.title}\n${timestamp}\n\n${notification.message}\n${'='.repeat(60)}\n`;

  console.error(formattedMessage);
}

async function sendDesktopNotification(
  notification: NotificationData
): Promise<void> {
  try {
    const platform = process.platform;

    if (platform === 'darwin') {
      await execFileAsync('osascript', [
        '-e',
        `display notification "${notification.message}" with title "${notification.title}"`,
      ]);
    } else if (platform === 'linux') {
      await execFileAsync('notify-send', [
        '--urgency',
        notification.priority === 'high' ? 'critical' : 'normal',
        '--icon',
        'info',
        notification.title,
        notification.message,
      ]);
    } else if (platform === 'win32') {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms;
        [System.Windows.Forms.MessageBox]::Show('${notification.message}', '${notification.title}', 'OK', 'Information');
      `;
      await execFileAsync('powershell', ['-Command', psScript]);
    } else {
      logDebug(`Desktop notifications not supported on platform: ${platform}`);
    }
  } catch (error) {
    logError('Failed to send desktop notification', toError(error));
  }
}

async function sendCustomNotification(
  notification: NotificationData,
  command: string
): Promise<void> {
  try {
    const processedCommand = command
      .replace(/\{title\}/g, notification.title)
      .replace(/\{message\}/g, notification.message)
      .replace(/\{priority\}/g, notification.priority)
      .replace(/\{icon\}/g, notification.icon);

    await execFileAsync('sh', ['-c', processedCommand], { timeout: 10000 });
  } catch (error) {
    logError('Failed to send custom notification', toError(error));
  }
}

async function sendSlackNotification(
  notification: NotificationData,
  webhookUrl: string
): Promise<void> {
  try {
    const payload = {
      text: `${notification.icon} ${notification.title}`,
      attachments: [
        {
          color: notification.priority === 'high' ? 'danger' : 'good',
          text: notification.message,
          footer: 'Claude Code',
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    const curlCommand = `curl -X POST -H 'Content-type: application/json' --data '${JSON.stringify(payload)}' '${webhookUrl}'`;
    await execFileAsync('sh', ['-c', curlCommand], { timeout: 10000 });
  } catch (error) {
    logError('Failed to send Slack notification', toError(error));
  }
}

async function sendEmailNotification(
  notification: NotificationData,
  emailConfig: NonNullable<NotificationConfig['email']>
): Promise<void> {
  try {
    const subject = notification.title.replace(/[🔐⏳❌🤖]/gu, '').trim();
    const body = `${notification.message}\n\n--\nSent by Claude Code Notification System`;

    const mailCommand = `echo "${body}" | mail -s "${subject}" ${emailConfig.to}`;
    await execFileAsync('sh', ['-c', mailCommand], { timeout: 10000 });
  } catch (error) {
    logError('Failed to send email notification', toError(error));
    logDebug('Make sure the "mail" command is available on your system');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<NotificationInput>(handleNotification).catch(error => {
    console.error('Failed to execute notification hook:', error);
    process.exit(1);
  });
}

export {
  handleNotification,
  getNotificationConfig,
  classifyNotification,
  sendDesktopNotification,
  sendSlackNotification,
};
