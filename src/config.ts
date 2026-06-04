import 'dotenv/config';

function required(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Mangler miljøvariabel: ${name}`);
  return value;
}

export const config = {
  PORT: Number(process.env.PORT ?? 4242),
  FRONTEND_URL: required('FRONTEND_URL', 'http://localhost:4242'),
  CURRENCY: process.env.CURRENCY ?? 'nok',
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
  STRIPE_SECRET_KEY: required('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET: required('STRIPE_WEBHOOK_SECRET'),
};
