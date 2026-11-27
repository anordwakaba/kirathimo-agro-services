# KIRATHIMO AGRO SERVICES

Vercel-ready React/Vite + Express + Neon PostgreSQL farm shop management system.

## Features
- Password login
- Owner/worker roles
- Add and edit inventory
- In-stock / out-of-stock status
- Automatic stock reduction on sales
- Automatic stock increase on purchases
- Sales, purchases, expenses and cash movements
- M-Pesa, Equity, KCB, Co-op, Eco Bank, Cash and Other
- Correct profit calculation: Sales - COGS - Expenses
- Five-second shared refresh for multiple devices
- PWA install support

## Deploy
Create a Neon PostgreSQL database, then add `DATABASE_URL` and `JWT_SECRET` to Vercel Environment Variables. Import this repository into Vercel and deploy.

The first user uses **First setup** to create the owner account. Afterwards, only invited emails can register.

Never commit secrets or tokens.
