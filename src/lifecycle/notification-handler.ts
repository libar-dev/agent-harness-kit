#!/usr/bin/env tsx

/**
 * Notification Handler Hook
 *
 * This hook handles Claude Code notifications by:
 * - Sending desktop notifications when Claude needs attention
 * - Logging notifications for audit purposes
 * - Supporting custom notification backends (email, Slack, etc.)
 * - Providing different notification styles based on message type
 */

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

/**
 * Configuration for notification handling
 */
interface NotificationConfig {
  /** Whether to show desktop notifications */
  desktop: boolean;
  /** Whether to log notifications to console */
  console: boolean;
  /** Whether to send notifications in CI environments */
  enableInCI: boolean;
  /** Custom notification command */
  customCommand?: string;
  /** Slack webhook URL */
  slackWebhook?: string;
  /** Email settings */
  email?: {
    to: string;
    from?: string;
    smtp?: string;
  };
}

/**
 * Notification data structure
 */
interface NotificationData {
  title: string;
  message: string;
  priority: 'low' | 'normal' | 'high';
  icon: string;
}

/**
 * Get notification configuration from environment
 */
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

/**
 * Main notification handling logic
 */
async function handleNotification(input: NotificationInput): Promise<void> {
  const { message, notification_type, session_id: _session_id } = input;
  const config = getNotificationConfig();

  logInfo(
    `Notification received: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`
  );

  // Skip notifications in CI unless explicitly enabled
  if (isCI() && !config.enableInCI) {
    logDebug('Skipping notification in CI environment');
    return;
  }

  // Determine notification type and priority
  const notificationType = classifyNotification(message, notification_type);
  const notification = {
    title: getNotificationTitle(notificationType),
    message: formatNotificationMessage(message, notificationType),
    priority: getNotificationPriority(notificationType),
    icon: getNotificationIcon(notificationType),
  };

  logDebug('Notification details', notification);

  // Send notifications through configured channels
  const promises: Promise<void>[] = [];

  // Console notification
  if (config.console) {
    promises.push(sendConsoleNotification(notification));
  }

  // Desktop notification
  if (config.desktop) {
    promises.push(sendDesktopNotification(notification));
  }

  // Custom command notification
  if (config.customCommand) {
    promises.push(sendCustomNotification(notification, config.customCommand));
  }

  // Slack notification
  if (config.slackWebhook) {
    promises.push(sendSlackNotification(notification, config.slackWebhook));
  }

  // Email notification
  if (config.email) {
    promises.push(sendEmailNotification(notification, config.email));
  }

  // Execute all notifications in parallel
  try {
    await Promise.all(promises);
    logDebug('All notifications sent successfully');
  } catch (error) {
    logError('Some notifications failed to send', toError(error));
  }
}

/**
 * Classify notification type based on message content
 */
function classifyNotification(
  message: string,
  notificationType?: NotificationInput['notification_type']
): 'permission' | 'waiting' | 'error' | 'info' {
  switch (notificationType) {
    case 'permission_prompt':
      return 'permission';
    case 'idle_prompt':
    case 'elicitation_dialog':
      return 'waiting';
    case 'auth_success':
      return 'info';
    default:
      break;
  }

  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('permission') || lowerMessage.includes('approve')) {
    return 'permission';
  } else if (
    lowerMessage.includes('waiting') ||
    lowerMessage.includes('input')
  ) {
    return 'waiting';
  } else if (
    lowerMessage.includes('error') ||
    lowerMessage.includes('failed')
  ) {
    return 'error';
  } else {
    return 'info';
  }
}

/**
 * Get notification title based on type
 */
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

/**
 * Format notification message for display
 */
function formatNotificationMessage(message: string, type: string): string {
  // Truncate very long messages
  if (message.length > 200) {
    message = message.substring(0, 197) + '...';
  }

  // Add context based on type
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

/**
 * Get notification priority
 */
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

/**
 * Get notification icon based on type
 */
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

/**
 * Send console notification
 */
async function sendConsoleNotification(
  notification: NotificationData
): Promise<void> {
  const timestamp = new Date().toISOString();
  const formattedMessage = `\n${'='.repeat(60)}\n${notification.icon} ${notification.title}\n${timestamp}\n\n${notification.message}\n${'='.repeat(60)}\n`;

  console.error(formattedMessage);
}

/**
 * Send desktop notification using system notification service
 */
async function sendDesktopNotification(
  notification: NotificationData
): Promise<void> {
  try {
    // Try different notification systems based on platform
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS - use osascript
      await execFileAsync('osascript', [
        '-e',
        `display notification "${notification.message}" with title "${notification.title}"`,
      ]);
    } else if (platform === 'linux') {
      // Linux - try notify-send
      await execFileAsync('notify-send', [
        '--urgency',
        notification.priority === 'high' ? 'critical' : 'normal',
        '--icon',
        'info', // Could map to different icons
        notification.title,
        notification.message,
      ]);
    } else if (platform === 'win32') {
      // Windows - use PowerShell
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

/**
 * Send custom notification using user-defined command
 */
async function sendCustomNotification(
  notification: NotificationData,
  command: string
): Promise<void> {
  try {
    // Replace placeholders in custom command
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

/**
 * Send Slack notification
 */
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

/**
 * Send email notification
 */
async function sendEmailNotification(
  notification: NotificationData,
  emailConfig: NonNullable<NotificationConfig['email']>
): Promise<void> {
  try {
    // Simple email sending using system mail command
    // For production use, consider using a proper email library
    const subject = notification.title.replace(/[🔐⏳❌🤖]/gu, '').trim();
    const body = `${notification.message}\n\n--\nSent by Claude Code Notification System`;

    const mailCommand = `echo "${body}" | mail -s "${subject}" ${emailConfig.to}`;
    await execFileAsync('sh', ['-c', mailCommand], { timeout: 10000 });
  } catch (error) {
    logError('Failed to send email notification', toError(error));
    logDebug('Make sure the "mail" command is available on your system');
  }
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<NotificationInput>(handleNotification).catch(error => {
    console.error('Failed to execute notification hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks
export {
  handleNotification,
  getNotificationConfig,
  classifyNotification,
  sendDesktopNotification,
  sendSlackNotification,
};
