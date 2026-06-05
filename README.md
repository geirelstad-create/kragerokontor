# Quad Booking – koblet frontend + backend

Dette prosjektet kobler `quad-booking.html` til en ekte backend med:

- Express/Node API
- Supabase/PostgreSQL database
- Stripe Checkout for kortbetaling
- Webhook som bekrefter booking etter betalt Stripe Checkout
- Faktura-valg som oppretter booking uten Stripe-redirect
- Konfliktsjekk for time-, dags- og månedsbooking

## 1. Opprett Supabase-tabeller

Kjør innholdet i `supabase-schema.sql` i Supabase SQL Editor.

## 2. Lag Stripe-nøkler

Hent testnøkkel i Stripe Dashboard og opprett webhook mot:

```text
https://dittdomene.no/api/stripe/webhook
```

For lokal utvikling kan du bruke Stripe CLI:

```bash
stripe listen --forward-to localhost:4242/api/stripe/webhook
```

## 3. Sett miljøvariabler

Kopier `.env.example` til `.env` og fyll inn verdiene:

```bash
cp .env.example .env
```

Viktig: `FRONTEND_URL` bør være samme URL som serveren viser HTML-en på. Lokalt:

```text
FRONTEND_URL=http://localhost:4242
```

## 4. Installer og kjør

```bash
npm install
npm run dev
```

Åpne deretter:

```text
http://localhost:4242
```

Backend serverer `public/index.html`, så frontend og API kjører på samme origin.

## API som frontenden bruker

- `GET /api/bookings` – henter bookinger til kalenderen
- `POST /api/create-checkout-session` – oppretter booking og Stripe Checkout
- `DELETE /api/bookings/:id` – kansellerer booking
- `POST /api/stripe/webhook` – Stripe bekrefter betalte bookinger

## Merk om Vipps

Knappen/valget `Vipps` finnes i frontenden. Stripe Checkout støtter tilgjengelige betalingsmetoder basert på Stripe-kontoen din. I denne starteren rutes Vipps-valget til Stripe Checkout med kort som fallback. For ekte Vipps må enten Vipps aktiveres via betalingsleverandøren din, eller det må lages egen Vipps eCom-integrasjon.


## E-post via Domeneshop SMTP

Legg disse miljøvariablene inn i Render:

```env
SMTP_HOST=smtp.domeneshop.no
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=post@kragerokontor.no
SMTP_PASS=passordet-til-epostkontoen
MAIL_FROM=Kragerø Kontor <post@kragerokontor.no>
MAIL_ADMIN=post@kragerokontor.no
```

E-post sendes etter at Stripe webhooken `checkout.session.completed` har bekreftet betaling og bookingen er satt til `confirmed`.

Hvis e-post feiler, blir bookingen likevel bekreftet. Feilen logges i Render Logs.
