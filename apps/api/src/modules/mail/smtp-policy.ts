export function smtpFailure(error: unknown) {
  const value = (error && typeof error === "object" ? error : {}) as { code?: string; command?: string; responseCode?: number };
  const code = value.code ?? "";
  const command = (value.command ?? "").toUpperCase();
  const response = value.responseCode;
  if (code === "EAUTH" || response === 535) return { code: "SMTP_AUTH_FAILED", retryable: false };
  if (response && response >= 500) return { code: "SMTP_REJECTED", retryable: false };
  // An explicit negative SMTP reply means the server did not accept delivery.
  if (response && response >= 400 && response < 500) return { code: "SMTP_TEMPORARY_REJECTION", retryable: true };
  if (["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO"].includes(command) && ["ETIMEDOUT", "ESOCKET", "ECONNECTION", "EDNS"].includes(code)) {
    return { code: "SMTP_CONNECTION_FAILED", retryable: true };
  }
  // A lost DATA response (or unknown transport state) may follow acceptance.
  return { code: "DELIVERY_UNCERTAIN_CHECK_INBOX", retryable: false };
}
