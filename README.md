# bomgardi-mehran
Bomgardi Mehran Reservation Management System
Cloudflare deployment started

## Preview SMS configuration

Preview builds pass the Melipayamak API URL and sender number from build-time secrets into the named Worker Preview as runtime secrets. Production settings are not changed.

## Booking source analytics

The admin dashboard includes a booking-source report with all-time, current Persian month, last 30 days, and current Persian year filters. It summarizes reservation requests, active reservations, pending and confirmed reservations, cancellations, booked amounts, and received payments by source. Report periods use reservation creation time.

## Guesthouse management enhancements

The experimental admin panel now includes:
- Daily arrivals, departures, and checked-in guest lists with check-in/check-out actions.
- Printable guest invoices and payment receipts.
- Per-room and global nightly pricing rules: normal, Thursday/Friday weekend, holidays, Nowruz, and peak periods. Special date ranges override weekend and normal rates; room-specific rules override global rules at the same rate type. The public booking page displays the calculated stay estimate when all nights have rates, and the Worker stores that quote on the reservation.
- Post-stay guest feedback links and ratings for cleanliness, staff, room quality, and overall satisfaction.
- JSON backup and multi-sheet XLSX export for reservations, guests, rooms, pricing rules, and reviews. Financial exports include reservation total, deposit, paid total, and balance; individual payment transactions are not separately stored in the current schema.

Before using pricing rules or guest feedback, run `database/upgrade-guesthouse-features.sql` once in the Supabase SQL Editor. This adds reservation review tokens and creates the pricing and review tables. Existing reservations receive review tokens without deleting booking data.

## Guest portal

The public home page includes a separate guest login at `/guest/`. A guest signs in with the mobile number registered on the reservation and the 8-character booking tracking code. Only reservations with status `confirmed`, `checked_in`, or `checked_out` can open the guest portal; pending and cancelled reservations are denied. The manager shortcut remains hidden on the guest login page and redirects to the manager sign-in page; actual manager access still requires the manager's Supabase credentials.

New bookings show only the tracking code. The guest welcome message prepared by the manager includes the registered mobile number, tracking code, and guest portal link.

After deploying this update, run `database/remove-guest-access-key.sql` once in the Supabase SQL Editor to remove the obsolete guest access-key hash column and its index.

## Manual bank transfer for guest reservations

The guest portal displays the Mehr Iran Bank transfer details for Erfan Doost Gol (card, account, and IBAN), with one-tap copy buttons and the contact number 09924950826. Guests do not submit payment amounts, dates, tracking numbers, or receipts through the website. The transfer panel is hidden when the reservation balance is fully settled.

An authenticated manager confirms a bank transfer from the reservation card. The amount is validated against the outstanding balance and recorded atomically in `reservation_payments`; the reservation's `paid_amount` is updated in the same database transaction. The admin reservation card shows the confirmed transfer history.

Before using this feature, run `database/upgrade-bank-transfer-payments.sql` once in the Supabase SQL Editor. This creates the payment ledger and the manager-only confirmation function. The manager must verify the transfer in the bank account before confirming it in the dashboard.
