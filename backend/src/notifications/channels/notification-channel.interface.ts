// The common shape every channel adapter implements (2026-08-27) — lets
// NotificationsService pick a channel at runtime without caring which one
// it is. Swapping a stub for a real provider later (MSG91, Twilio, SES,
// whatever gets chosen) means implementing this interface, nothing else in
// the notification pipeline changes.
export interface NotificationRecipient {
  email: string;
  // No `phone` field exists on User yet (2026-08-27) — flagged, not solved.
  // SMS/WhatsApp adapters can't actually reach anyone until that's added,
  // which needs its own confirmation (touches Login identity rules — see
  // CLAUDE.md's Role & Access model). Left optional/undefined here so the
  // interface is ready the moment it exists.
  phone?: string | null;
}

export interface NotificationSendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface NotificationChannelAdapter {
  send(recipient: NotificationRecipient, message: string): Promise<NotificationSendResult>;
}
