import nodemailer from 'nodemailer';
import { config } from './config.js';

type BookingRow = {
  id: string;
  room: string;
  mode: string;
  start_date: string;
  end_date: string | null;
  hour: number | null;
  label: string | null;
  amount_nok: number;
  customer_name: string;
  customer_company: string | null;
  customer_email: string;
  customer_phone: string | null;
  message: string | null;
  status: string;
};

function smtpReady() {
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS && config.MAIL_FROM);
}

const transporter = smtpReady()
  ? nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    })
  : null;

function formatPeriod(booking: BookingRow) {
  if (booking.mode === 'hour') {
    const h = String(booking.hour ?? 0).padStart(2, '0');
    return `${booking.start_date} kl. ${h}:00`;
  }
  if (booking.end_date && booking.end_date !== booking.start_date) {
    return `${booking.start_date} til ${booking.end_date}`;
  }
  return booking.start_date;
}

function customerText(booking: BookingRow) {
  return `Hei ${booking.customer_name},

Takk for bookingen hos Kragerø Kontor.

Bookingdetaljer:
Kontor: ${booking.room}
Periode: ${formatPeriod(booking)}
Pris: ${booking.amount_nok} kr
Booking-ID: ${booking.id}

Vi har registrert betalingen og bookingen er bekreftet.

Vennlig hilsen
Kragerø Kontor`;
}

function customerHtml(booking: BookingRow) {
  return `<p>Hei ${booking.customer_name},</p>
<p>Takk for bookingen hos <strong>Kragerø Kontor</strong>.</p>
<h3>Bookingdetaljer</h3>
<ul>
  <li><strong>Kontor:</strong> ${booking.room}</li>
  <li><strong>Periode:</strong> ${formatPeriod(booking)}</li>
  <li><strong>Pris:</strong> ${booking.amount_nok} kr</li>
  <li><strong>Booking-ID:</strong> ${booking.id}</li>
</ul>
<p>Vi har registrert betalingen og bookingen er bekreftet.</p>
<p>Vennlig hilsen<br>Kragerø Kontor</p>`;
}

function adminText(booking: BookingRow) {
  return `Ny bekreftet booking

Kontor: ${booking.room}
Periode: ${formatPeriod(booking)}
Pris: ${booking.amount_nok} kr
Booking-ID: ${booking.id}

Kunde: ${booking.customer_name}
Firma: ${booking.customer_company ?? '-'}
E-post: ${booking.customer_email}
Telefon: ${booking.customer_phone ?? '-'}
Melding: ${booking.message ?? '-'}`;
}

export async function sendBookingConfirmation(booking: BookingRow) {
  if (!transporter || !config.MAIL_FROM) {
    console.warn('SMTP er ikke konfigurert. Hopper over e-post for booking', booking.id);
    return;
  }

  await transporter.sendMail({
    from: config.MAIL_FROM,
    to: booking.customer_email,
    subject: `Booking bekreftet – ${booking.room}`,
    text: customerText(booking),
    html: customerHtml(booking),
  });

  if (config.MAIL_ADMIN) {
    await transporter.sendMail({
      from: config.MAIL_FROM,
      to: config.MAIL_ADMIN,
      subject: `Ny booking – ${booking.room}`,
      text: adminText(booking),
    });
  }
}
