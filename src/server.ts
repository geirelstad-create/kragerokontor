import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { supabase } from './supabase.js';
import { stripe } from './stripe.js';
import { sendBookingConfirmation } from './mailer.js';
import { vippsConfigured, createVippsPayment, getVippsPayment, captureVippsPayment } from './vipps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');
const app = express();

type Booking = {
  id: string;
  office_id: string;
  room: string;
  mode: 'day' | 'week' | 'month';
  start_date: string;
  end_date: string | null;
  months: number;
  status: string;
};

function addDays(dateStr: string, days: number) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDaysInclusive(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.round((end - start) / 86400000) + 1;
}

// Offentlig: kun det kalenderen trenger. INGEN persondata.
function publicBooking(row: any) {
  return {
    id: row.id,
    office: row.office_id,
    room: row.room,
    mode: row.mode,
    date: row.start_date,
    endDate: row.end_date,
    months: row.months,
    status: row.status,
  };
}

// Admin: full info (kun bak innlogging).
function adminBooking(row: any) {
  return {
    id: row.id,
    office: row.office_id,
    room: row.room,
    mode: row.mode,
    date: row.start_date,
    endDate: row.end_date,
    months: row.months,
    qty: row.qty,
    label: row.label,
    total: row.amount_nok,
    name: row.customer_name,
    company: row.customer_company,
    orgno: row.customer_orgno,
    email: row.customer_email,
    phone: row.customer_phone,
    pay: row.payment_method,
    msg: row.message,
    status: row.status,
    receiptNo: row.receipt_no,
    created: row.created_at,
  };
}

function conflicts(candidate: { officeId: string; mode: string; startDate: string; endDate: string }, existing: Booking[]) {
  const cStart = new Date(`${candidate.startDate}T00:00:00Z`).getTime();
  const cEnd = new Date(`${candidate.endDate}T00:00:00Z`).getTime();
  for (const b of existing) {
    if (b.office_id !== candidate.officeId) continue;
    const bStart = new Date(`${b.start_date}T00:00:00Z`).getTime();
    const bEnd = new Date(`${b.end_date ?? b.start_date}T00:00:00Z`).getTime();
    const dateOverlap = cStart <= bEnd && bStart <= cEnd;
    if (dateOverlap) return true;
  }
  return false;
}

async function assertAvailable(officeId: string, mode: string, startDate: string, endDate: string) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id,office_id,room,mode,start_date,end_date,months,status')
    .eq('office_id', officeId)
    .in('status', ['pending_payment', 'pending_invoice', 'confirmed']);
  if (error) throw error;
  return !conflicts({ officeId, mode, startDate, endDate }, (data ?? []) as Booking[]);
}

// Felles prisberegning på serveren (fasiten – ikke det frontend sender)
async function computeBooking(officeId: string, mode: string, startDate: string, endDateIn: string | null | undefined, months: number) {
  const { data: office, error: officeError } = await supabase
    .from('offices').select('*').eq('id', officeId).eq('active', true).single();
  if (officeError || !office) throw new Error('Ukjent kontor');

  let endDate = startDate;
  let qty = 1;
  let unit = 0;
  let label = '';
  if (mode === 'day') {
    endDate = endDateIn ?? startDate;
    qty = diffDaysInclusive(startDate, endDate);
    unit = office.price_day_nok; label = `${qty} dag${qty > 1 ? 'er' : ''}`;
  } else if (mode === 'week') {
    endDate = addDays(startDate, 6); qty = 1;
    unit = office.price_week_nok; label = '1 uke';
  } else {
    endDate = addDays(startDate, months * 30 - 1); qty = months;
    unit = office.price_month_nok; label = `${qty} måned${qty > 1 ? 'er' : ''}`;
  }
  const amountNok = unit * qty;
  return { office, endDate, qty, unit, label, amountNok };
}

// Felles "fullfør booking": tildel kvitteringsnummer + send bekreftelse/kvittering.
// Idempotent fordi assign_receipt ikke gir nytt nummer hvis det allerede finnes.
async function finalizeConfirmedBooking(bookingId: string, confirmedRow: any) {
  let bookingForMail: any = confirmedRow;
  try {
    const { data: rec, error: recError } = await supabase
      .rpc('assign_receipt', { p_booking_id: bookingId }).single();
    if (recError) console.error('Kunne ikke tildele kvitteringsnummer:', recError.message);
    else if (rec) bookingForMail = { ...confirmedRow, receipt_no: (rec as any).receipt_no, receipt_date: (rec as any).receipt_date };
  } catch (recErr) {
    console.error('Feil ved tildeling av kvitteringsnummer:', recErr);
  }
  try {
    await sendBookingConfirmation(bookingForMail);
  } catch (mailError) {
    console.error('Kunne ikke sende bookingbekreftelse:', mailError);
  }
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, config.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata?.bookingId;
    if (bookingId) {
      const { data: updatedBooking, error: updateError } = await supabase
        .from('bookings')
        .update({
          status: 'confirmed',
          stripe_payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
          confirmed_at: new Date().toISOString(),
        })
        .eq('id', bookingId)
        .eq('status', 'pending_payment')
        .select('*')
        .single();

      if (updateError) {
        console.error('Kunne ikke oppdatere booking etter Stripe-betaling:', updateError.message);
      } else if (updatedBooking) {
        await finalizeConfirmedBooking(bookingId, updatedBooking);
      }
    }
  }

  res.json({ received: true });
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.FRONTEND_URL }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/offices', async (_req, res) => {
  const { data, error } = await supabase.from('offices').select('*').eq('active', true).order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/bookings', async (_req, res) => {
  // Offentlig endepunkt – brukes til å tegne kalenderen. Returnerer KUN
  // kontor/dato/status, ingen persondata.
  const { data, error } = await supabase
    .from('bookings')
    .select('id,office_id,room,mode,start_date,end_date,months,status')
    .in('status', ['pending_payment', 'pending_invoice', 'confirmed'])
        .order('start_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(publicBooking));
});

// ---- Admin-autentisering (passord fra miljøvariabel) ----
function adminAuthorized(req: express.Request): boolean {
  const expected = config.ADMIN_PASSWORD;
  if (!expected) return false; // ingen passord satt = admin avslått
  const header = req.header('x-admin-password') || '';
  // konstant-tid-sammenligning
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

app.get('/api/admin/bookings', async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .in('status', ['pending_payment', 'pending_invoice', 'confirmed'])
    .order('start_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(adminBooking));
});

app.delete('/api/bookings/:id', async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const { error } = await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/create-checkout-session', async (req, res) => {
  const Body = z.object({
    officeId: z.enum(['a', 'b', 'c']),
    mode: z.enum(['day', 'week', 'month']),
    startDate: z.string().date(),
    endDate: z.string().date().nullable().optional(),
    months: z.number().int().min(1).max(24).default(1),
    customerName: z.string().min(2),
    customerCompany: z.string().optional(),
    customerOrgNo: z.string().optional(),
    customerEmail: z.string().email(),
    customerPhone: z.string().min(8),
    paymentMethod: z.enum(['card']).default('card'),
    message: z.string().optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const b = parsed.data;

  try {
    const { office, endDate, qty, label, amountNok } = await computeBooking(b.officeId, b.mode, b.startDate, b.endDate, b.months);
    if (diffDaysInclusive(b.startDate, endDate) <= 0) return res.status(400).json({ error: 'Ugyldig bookingperiode' });
    if (amountNok < 1) return res.status(400).json({ error: 'Ugyldig beløp' });

    const available = await assertAvailable(b.officeId, b.mode, b.startDate, endDate);
    if (!available) return res.status(409).json({ error: 'Kontoret er ikke ledig i valgt periode' });

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        office_id: b.officeId,
        room: office.room,
        mode: b.mode,
        start_date: b.startDate,
        end_date: endDate,
        months: b.mode === 'month' ? b.months : 1,
        qty,
        label,
        amount_nok: amountNok,
        customer_name: b.customerName,
        customer_company: b.customerCompany ?? null,
        customer_orgno: b.customerOrgNo ?? null,
        customer_email: b.customerEmail,
        customer_phone: b.customerPhone ?? null,
        payment_method: b.paymentMethod,
        message: b.message ?? null,
        status: 'pending_payment',
      })
      .select('*')
      .single();

    if (bookingError || !booking) return res.status(409).json({ error: bookingError?.message ?? 'Kunne ikke opprette booking' });

    const paymentMethodTypes = ['card'];
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: b.customerEmail,
      payment_method_types: paymentMethodTypes as any,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: config.CURRENCY,
          unit_amount: amountNok * 100,
          product_data: {
            name: `${office.room} – ${label}`,
            description: `${b.startDate} til ${endDate}`,
          },
        },
      }],
      success_url: `${config.FRONTEND_URL}/?booking=success&bookingId=${booking.id}`,
      cancel_url: `${config.FRONTEND_URL}/?booking=cancelled&bookingId=${booking.id}`,
      metadata: { bookingId: booking.id },
    });

    await supabase.from('bookings').update({ stripe_session_id: session.id }).eq('id', booking.id);
    res.json({ checkoutUrl: session.url, bookingId: booking.id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// ---------- Vipps ePayment ----------
app.post('/api/vipps/create', async (req, res) => {
  if (!vippsConfigured()) return res.status(503).json({ error: 'Vipps er ikke konfigurert på serveren' });

  const Body = z.object({
    officeId: z.enum(['a', 'b', 'c']),
    mode: z.enum(['day', 'week', 'month']),
    startDate: z.string().date(),
    endDate: z.string().date().nullable().optional(),
    months: z.number().int().min(1).max(24).default(1),
    customerName: z.string().min(2),
    customerCompany: z.string().optional(),
    customerOrgNo: z.string().optional(),
    customerEmail: z.string().email(),
    customerPhone: z.string().min(8), // påkrevd for Vipps
    message: z.string().optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;

  // Normaliser telefonnummer til MSISDN (4791234567)
  let phone = b.customerPhone.replace(/\s|-/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.length === 8) phone = '47' + phone; // norsk nummer uten landkode

  try {
    const { office, endDate, qty, label, amountNok } = await computeBooking(b.officeId, b.mode, b.startDate, b.endDate, b.months);
    if (diffDaysInclusive(b.startDate, endDate) <= 0) return res.status(400).json({ error: 'Ugyldig bookingperiode' });
    if (amountNok < 1) return res.status(400).json({ error: 'Ugyldig beløp' });

    const available = await assertAvailable(b.officeId, b.mode, b.startDate, endDate);
    if (!available) return res.status(409).json({ error: 'Kontoret er ikke ledig i valgt periode' });

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        office_id: b.officeId, room: office.room, mode: b.mode,
        start_date: b.startDate, end_date: endDate,
        months: b.mode === 'month' ? b.months : 1, qty, label, amount_nok: amountNok,
        customer_name: b.customerName, customer_company: b.customerCompany ?? null,
        customer_orgno: b.customerOrgNo ?? null, customer_email: b.customerEmail,
        customer_phone: b.customerPhone ?? null, payment_method: 'vipps',
        message: b.message ?? null, status: 'pending_payment',
      })
      .select('*').single();
    if (bookingError || !booking) return res.status(409).json({ error: bookingError?.message ?? 'Kunne ikke opprette booking' });

    const returnUrl = `${config.FRONTEND_URL}/?booking=vipps-return&bookingId=${booking.id}`;
    const { redirectUrl } = await createVippsPayment({
      reference: booking.id,
      amountNok,
      phoneNumber: phone,
      description: `${office.room} – ${label}`,
      returnUrl,
    });

    res.json({ checkoutUrl: redirectUrl, bookingId: booking.id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// Vipps webhook: kalles av Vipps når betalingsstatus endres.
async function handleVippsAuthorized(reference: string) {
  // Verifiser status mot Vipps før vi bekrefter (ikke stol blindt på webhook-innhold)
  const payment = await getVippsPayment(reference);
  const state = payment?.state; // AUTHORIZED | ABORTED | EXPIRED ...
  if (state !== 'AUTHORIZED') return;

  // Hent booking og beløp
  const { data: booking } = await supabase.from('bookings').select('*').eq('id', reference).single();
  if (!booking) return;

  // Capture (trekk hele beløpet) – idempotent nok via try/catch; Vipps tåler gjentatt capture-forsøk dårlig,
  // så vi capture-r kun hvis booking ikke allerede er bekreftet.
  if (booking.status !== 'confirmed') {
    try {
      await captureVippsPayment(reference, booking.amount_nok);
    } catch (capErr) {
      console.error('Vipps capture feilet for', reference, capErr);
      return; // ikke bekreft hvis vi ikke fikk trukket
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from('bookings')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', reference)
    .neq('status', 'confirmed')
    .select('*').single();

  if (updErr) {
    // Hvis allerede bekreftet (ingen rad oppdatert) er det greit – unngå dobbel kvittering
    return;
  }
  if (updated) {
    await finalizeConfirmedBooking(reference, updated);
  }
}

app.post('/api/vipps/webhook', async (req, res) => {
  // Svar raskt 200 så Vipps ikke re-sender; behandle deretter.
  res.json({ received: true });
  try {
    const reference = req.body?.reference || req.body?.orderId;
    const name = (req.body?.name || '').toString().toUpperCase();
    // Vi reagerer på autorisert/captured-hendelser
    if (reference && (name.includes('AUTHORIZED') || name.includes('CAPTURED') || req.body?.success === true)) {
      await handleVippsAuthorized(reference);
    } else if (reference) {
      // Som fallback: sjekk status uansett hendelsestype
      await handleVippsAuthorized(reference);
    }
  } catch (err) {
    console.error('Vipps webhook-feil:', err);
  }
});

app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.listen(config.PORT, () => {
  console.log(`Quad booking kjører på ${config.FRONTEND_URL}`);
});
