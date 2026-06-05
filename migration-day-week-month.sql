-- Migrasjon: time/dag/måned  ->  dag/uke/måned
-- Kjør denne i Supabase SQL Editor på den EKSISTERENDE databasen.
-- Trygg å kjøre: beholder eksisterende bookinger.

-- 1) Legg til ukespris-kolonne (default midlertidig, fjernes etterpå)
alter table offices add column if not exists price_week_nok int not null default 0;

-- 2) (valgfritt) hour-kolonnen er ikke lenger i bruk. Vi lar den stå for ikke å
--    miste historiske data, men nye bookinger bruker den ikke.

-- 3) Oppdater mode-constraint: tillat day/week/month
--    Gamle 'hour'-bookinger konverteres til 'day' så de ikke bryter ny constraint.
update bookings set mode = 'day' where mode = 'hour';

alter table bookings drop constraint if exists bookings_mode_check;
alter table bookings add constraint bookings_mode_check
  check (mode in ('day','week','month'));

-- 4) Sett prisene per kontor
update offices set price_day_nok = 490, price_week_nok = 2500, price_month_nok = 6500 where id = 'a';
update offices set price_day_nok = 490, price_week_nok = 2500, price_month_nok = 6500 where id = 'b';
update offices set price_day_nok = 390, price_week_nok = 1900, price_month_nok = 4900 where id = 'c';

-- 5) Fjern default på ukespris nå som alle rader har verdi
alter table offices alter column price_week_nok drop default;

-- 6) Sørg for at orgno-kolonne finnes (frontend sender den)
alter table bookings add column if not exists customer_orgno text;
