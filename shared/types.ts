export type Category = "Mobile" | "Misto" | "Emulador" | "Tatico" | "Full-Soco";

export const ALL_CATEGORIES: Category[] = [
  "Mobile",
  "Misto",
  "Emulador",
  "Tatico",
  "Full-Soco",
];

export interface Org {
  id: number;
  guild_id: string | null;
  name: string;
  category: Category;
  max_queues: number;
  enabled: boolean;
  priority: number;
  channels_count?: number;
  last_scanned_at?: string | null;
}

export interface OrgChannelButton {
  label: string;
  custom_id: string | null;
  style: number;
  disabled: boolean;
  action: "enter" | "leave" | "play" | "other" | null;
  variant: "normal" | "gel_normal" | "gel_inf" | "full_ump_xm8" | null;
}

export interface OrgChannel {
  id: number;
  channel_id: string;
  channel_name: string | null;
  category: Category | null;
  mode: string | null;
  message_id: string | null;
  embed_title: string | null;
  application_id?: string | null;
  buttons: OrgChannelButton[];
  last_scanned_at: string | null;
}

export interface InstanceConfig {
  category: Category;
  allowed_categories: string;
  delay_seconds: number;
  rotation_minutes: number;
  allowed_modes: string;
  message_main: string;
  message_per_org: string;
  image_url: string | null;
  blocked_names: string;
}

export interface Token {
  id: number;
  position: number;
  value_preview: string;
  status: "unknown" | "connected" | "invalid" | "rate_limited" | "disconnected";
  username: string | null;
}

export interface InstanceState {
  id: number;
  name: string;
  running: boolean;
  connected: boolean;
  user_handle: string | null;
  uptime_seconds: number;
  stats: {
    entradas: number;
    na_fila: number;
    partidas: number;
    dms: number;
  };
  tokens_active: number;
  tokens_total: number;
  next_rotation_seconds: number;
}
