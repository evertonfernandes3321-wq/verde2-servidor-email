import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';

// Criar transporter Nodemailer
const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: false, // true para 465, false para 587
  auth: {
    user: config.smtp.user,
    pass: config.smtp.password,
  },
  tls: {
    rejectUnauthorized: false, // Para desenvolvimento
  },
});

// Verificar conexão SMTP ao iniciar
export async function verifySmtpConnection() {
  try {
    await transporter.verify();
    log.info('Conexão SMTP verificada com sucesso');
    return true;
  } catch (err) {
    log.error({ err }, 'Falha ao verificar conexão SMTP');
    return false;
  }
}

// Enviar email
export async function sendEmail({ to, subject, html, text, from, replyTo }) {
  const fromEmail = from || config.fromEmail;

  const mailOptions = {
    from: `"${config.emailDomain}" <${fromEmail}>`,
    to,
    subject,
    html,
    text,
    replyTo: replyTo || fromEmail,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    log.info({
      messageId: info.messageId,
      to,
      subject,
    }, 'Email enviado com sucesso');

    return {
      success: true,
      messageId: info.messageId,
      response: info.response,
    };
  } catch (err) {
    log.error({
      err,
      to,
      subject,
    }, 'Falha ao enviar email');

    return {
      success: false,
      error: err.message,
      code: err.code,
    };
  }
}

// Renderizar template com Handlebars
export function renderTemplate(template, variables) {
  let subject = template.subject;
  let bodyHtml = template.body_html;
  let bodyText = template.body_text;

  // Compilar e renderizar subject
  if (variables) {
    try {
      const subjectTemplate = handlebars.compile(subject);
      subject = subjectTemplate(variables);
    } catch (err) {
      log.warn({ err, template: template.slug }, 'Erro ao renderizar subject');
    }

    // Renderizar body HTML
    if (bodyHtml) {
      try {
        const htmlTemplate = handlebars.compile(bodyHtml);
        bodyHtml = htmlTemplate(variables);
      } catch (err) {
        log.warn({ err, template: template.slug }, 'Erro ao renderizar body HTML');
      }
    }

    // Renderizar body texto
    if (bodyText) {
      try {
        const textTemplate = handlebars.compile(bodyText);
        bodyText = textTemplate(variables);
      } catch (err) {
        log.warn({ err, template: template.slug }, 'Erro ao renderizar body texto');
      }
    }
  }

  return {
    subject,
    bodyHtml,
    bodyText,
  };
}

export { transporter };
