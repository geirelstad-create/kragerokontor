import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { supabase } from './supabase.js';
import { stripe } from './stripe.js';
import { sendBookingConfirmation } from './mailer.js';

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

function frontendBooking(row: any) {
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
        try {
          await sendBookingConfirmation(updatedBooking as any);
        } catch (mailError) {
          console.error('Kunne ikke sende bookingbekreftelse:', mailError);
        }
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
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .in('status', ['pending_payment', 'pending_invoice', 'confirmed'])
        .order('start_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(frontendBooking));
});

app.delete('/api/bookings/:id', async (req, res) => {
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
    customerPhone: z.string().optional(),
    paymentMethod: z.enum(['card']).default('card'),
    message: z.string().optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const b = parsed.data;

  try {
    // Hent kontoret fra databasen – prisene her er fasiten (ikke det frontend sender)
    const { data: office, error: officeError } = await supabase
      .from('offices')
      .select('*')
      .eq('id', b.officeId)
      .eq('active', true)
      .single();
    if (officeError || !office) return res.status(400).json({ error: 'Ukjent kontor' });

    // Beregn periode og beløp på serveren
    let endDate = b.startDate;
    let qty = 1;
    let unit = 0;
    let label = '';

    if (b.mode === 'day') {
      endDate = b.endDate ?? b.startDate;
      qty = diffDaysInclusive(b.startDate, endDate);
      unit = office.price_day_nok;
      label = `${qty} dag${qty > 1 ? 'er' : ''}`;
    } else if (b.mode === 'week') {
      endDate = addDays(b.startDate, 6); // alltid nøyaktig 7 dager
      qty = 1;
      unit = office.price_week_nok;
      label = '1 uke';
    } else { // month
      endDate = addDays(b.startDate, b.months * 30 - 1);
      qty = b.months;
      unit = office.price_month_nok;
      label = `${qty} måned${qty > 1 ? 'er' : ''}`;
    }

    if (diffDaysInclusive(b.startDate, endDate) <= 0) return res.status(400).json({ error: 'Ugyldig bookingperiode' });

    const amountNok = unit * qty; // ingen mva
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

app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.listen(config.PORT, () => {
  console.log(`Quad booking kjører på ${config.FRONTEND_URL}`);
});
