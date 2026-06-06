import nodemailer from 'nodemailer';
import { config } from './config.js';
import { generateReceiptPdf, ReceiptData } from './receipt.js';

export type BookingRow = {
  id: string;
  room: string;
  mode: string;
  start_date: string;
  end_date: string | null;
  label: string | null;
  amount_nok: number;
  customer_name: string;
  customer_company: string | null;
  customer_orgno: string | null;
  customer_email: string;
  customer_phone: string | null;
  payment_method: string | null;
  message: string | null;
  status: string;
  receipt_no: number | null;
  receipt_date: string | null;
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
  if (booking.end_date && booking.end_date !== booking.start_date) {
    return `${booking.start_date} til ${booking.end_date}`;
  }
  return booking.start_date;
}

function receiptLabel(booking: BookingRow): string | null {
  if (booking.receipt_no == null) return null;
  const year = booking.receipt_date ? new Date(booking.receipt_date).getFullYear() : new Date().getFullYear();
  return `KVITT-${year}-${booking.receipt_no}`;
}

function customerText(booking: BookingRow) {
  const kvitt = receiptLabel(booking);
  return `Hei ${booking.customer_name},

Takk for bookingen hos Quad AS.

Bookingdetaljer:
Kontor: ${booking.room}
Periode: ${formatPeriod(booking)}
Pris: ${booking.amount_nok} kr
${kvitt ? `Kvittering: ${kvitt}` : `Booking-ID: ${booking.id}`}

Vi har registrert betalingen og bookingen er bekreftet.${kvitt ? ' Kvittering er vedlagt denne e-posten som PDF.' : ''}

Vennlig hilsen
Quad AS`;
}

function customerHtml(booking: BookingRow) {
  const kvitt = receiptLabel(booking);
  return `<p>Hei ${booking.customer_name},</p>
<p>Takk for bookingen hos <strong>Quad AS</strong>.</p>
<h3>Bookingdetaljer</h3>
<ul>
  <li><strong>Kontor:</strong> ${booking.room}</li>
  <li><strong>Periode:</strong> ${formatPeriod(booking)}</li>
  <li><strong>Pris:</strong> ${booking.amount_nok} kr</li>
  ${kvitt ? `<li><strong>Kvittering:</strong> ${kvitt}</li>` : `<li><strong>Booking-ID:</strong> ${booking.id}</li>`}
</ul>
<p>Vi har registrert betalingen og bookingen er bekreftet.${kvitt ? ' Kvittering er vedlagt denne e-posten som PDF.' : ''}</p>
<p>Vennlig hilsen<br>Quad AS</p>`;
}

function adminText(booking: BookingRow) {
  const kvitt = receiptLabel(booking);
  return `Ny bekreftet booking

Kontor: ${booking.room}
Periode: ${formatPeriod(booking)}
Pris: ${booking.amount_nok} kr
${kvitt ? `Kvittering: ${kvitt}` : `Booking-ID: ${booking.id}`}

Kunde: ${booking.customer_name}
Firma: ${booking.customer_company ?? '-'}
Org.nr: ${booking.customer_orgno ?? '-'}
E-post: ${booking.customer_email}
Telefon: ${booking.customer_phone ?? '-'}
Melding: ${booking.message ?? '-'}`;
}

export async function sendBookingConfirmation(booking: BookingRow) {
  if (!transporter || !config.MAIL_FROM) {
    console.warn('SMTP er ikke konfigurert. Hopper over e-post for booking', booking.id);
    return;
  }

  // Lag kvitterings-PDF hvis booking har fått kvitteringsnummer
  const attachments: any[] = [];
  const kvitt = receiptLabel(booking);
  if (kvitt) {
    try {
      const data: ReceiptData = {
        receiptLabel: kvitt,
        receiptDate: booking.receipt_date ? new Date(booking.receipt_date) : new Date(),
        room: booking.room,
        mode: booking.mode,
        startDate: booking.start_date,
        endDate: booking.end_date,
        label: booking.label,
        amountNok: booking.amount_nok,
        customerName: booking.customer_name,
        customerCompany: booking.customer_company,
        customerOrgNo: booking.customer_orgno,
        customerEmail: booking.customer_email,
        paymentMethod: booking.payment_method ?? 'card',
      };
      const pdf = await generateReceiptPdf(data);
      attachments.push({ filename: `${kvitt}.pdf`, content: pdf, contentType: 'application/pdf' });
    } catch (err) {
      console.error('Kunne ikke generere kvitterings-PDF for', booking.id, err);
      // Vi sender e-posten uansett, bare uten vedlegg.
    }
  }

  await transporter.sendMail({
    from: config.MAIL_FROM,
    to: booking.customer_email,
    subject: `Booking bekreftet – ${booking.room}`,
    text: customerText(booking),
    html: customerHtml(booking),
    attachments,
  });

  if (config.MAIL_ADMIN) {
    await transporter.sendMail({
      from: config.MAIL_FROM,
      to: config.MAIL_ADMIN,
      subject: `Ny booking – ${booking.room}`,
      text: adminText(booking),
      attachments,
    });
  }
}
