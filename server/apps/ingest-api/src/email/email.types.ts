export const EMAIL_QUEUE = "emails";
export const EMAIL_JOB_SEND = "send";

export interface EmailJob {
  to: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  tag?: string;
}
