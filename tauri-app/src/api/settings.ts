import { invoke } from '@tauri-apps/api/core';
import { AppSettings, McpServerConfig } from '../types/settings';

export type { McpServerConfig, AppSettings };

/**
 * Get application settings
 */
export async function getSettings(): Promise<AppSettings> {
    return await invoke<AppSettings>('get_settings');
}

/**
 * Save application settings
 */
export async function saveSettings(newSettings: AppSettings): Promise<void> {
    return await invoke('save_settings', { newSettings });
}
