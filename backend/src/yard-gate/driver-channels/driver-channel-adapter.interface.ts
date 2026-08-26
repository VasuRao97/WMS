// Adapter contract for reaching a Driver (not a User) — phone-only, no
// email, since Driver has no login/email at all. Separate from
// notifications/channels/'s NotificationChannelAdapter interface on
// purpose: a Driver and a User are different recipient concepts in this
// codebase (see DriverDockNotification's schema comment), reached over a
// different (and currently smaller) set of channels.
export interface DriverSendResult {
  success: boolean;
  error?: string;
}

export interface DriverChannelAdapter {
  send(phone: string, message: string): Promise<DriverSendResult>;
}
