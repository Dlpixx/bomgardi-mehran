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
