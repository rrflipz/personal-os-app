# Personal OS

An adaptive AI life-navigation agent with accounts, a free tier, and a paywall.

## How it's built (read this before touching code)

```
personal-os-app/
├── server.js                    <- the whole backend: auth, chat, payments, password reset
├── db.js                        <- Postgres database layer (accounts, conversations)
├── public/index.html            <- the whole frontend: login screen + chat UI
├── public/reset-password.html   <- the page a reset-password email link opens
├── .env.example                 <- copy to .env and fill in real values
└── package.json
```

The most important idea in this whole app: **the Anthropic API key lives only on
the server (`server.js`), never in the browser.** The frontend talks to *our*
server (`/api/chat`), and our server talks to Anthropic. That's the only way a
paywall can actually work — anything that runs entirely in the browser can be
inspected and the "paywall" bypassed by anyone who opens dev tools.

## 1. Run it locally

You need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd personal-os-app
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `JWT_SECRET` — any long random string (e.g. run `openssl rand -hex 32`)
- `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)
- `DATABASE_URL` — a Postgres connection string. Locally, either run
  Postgres on your own machine, or just point this at your Render Postgres
  instance's **External Database URL** (found on its "Connections" tab)
  while developing.

Leave the Stripe values blank for now — the app works fine without them, it'll
just say "Payments are not set up yet" if someone clicks Upgrade.

```bash
npm start
```

Open `http://localhost:3000`. Create an account, chat with it, watch the
"System profile" panel fill in on the right.

## 2. Turn on the paywall (Stripe)

1. Create a free [Stripe](https://stripe.com) account.
2. In the Stripe dashboard, create a **Product** (e.g. "Personal OS Pro") with
   a recurring **Price** (e.g. $9.99/month). Copy the Price ID (starts with `price_`).
3. Copy your **Secret key** (starts with `sk_test_` while testing).
4. Put both in `.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PRICE_ID=price_...
   ```
5. For webhooks (this is what actually flips a user to "Pro" after they pay),
   install the [Stripe CLI](https://stripe.com/docs/stripe-cli) and run:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe-webhook
   ```
   It'll print a `whsec_...` value — put that in `.env` as `STRIPE_WEBHOOK_SECRET`
   and restart `npm start`.
6. Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC,
   to test a real checkout end to end.

## 3. Deploy it so other people can use it

Any Node.js host works. Two easy free-to-start options: **Render** or
**Railway**.

General steps (Render as the example):
1. Push this folder to a GitHub repo.
2. On Render, create a new **Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add all your `.env` values as environment variables in Render's dashboard
   (never commit the real `.env` file — `.gitignore` already excludes it).
5. Set `CLIENT_URL` to your real deployed URL (e.g. `https://personal-os.onrender.com`)
   so Stripe's checkout redirect works correctly.
6. Once deployed, switch your Stripe keys from test mode to live mode, and
   point a live webhook at `https://your-domain.com/api/stripe-webhook`
   (Stripe dashboard → Developers → Webhooks → Add endpoint).

## 4. Password reset (Resend)

Forgotten-password emails go out through [Resend](https://resend.com). You need:
1. A Resend account with your domain added and verified (their dashboard walks
   you through the DNS records).
2. An API key from Resend, put in `.env` as `RESEND_API_KEY`.
3. `EMAIL_FROM` in `.env` set to an address on your verified domain, e.g.
   `"Personal OS <noreply@yourdomain.com>"`.

Without `RESEND_API_KEY` set, the app doesn't crash -- it just logs the reset
link to the console instead of emailing it, which is handy for local testing.

## 5. Known limits worth knowing about (and fixing later, not day one)

- **Free tier is a flat message count.** Easy first version. You may later
  want it to reset monthly instead of being lifetime — that's a small change
  to the `freeMessagesUsed` logic in `server.js`.

## 6. The product itself

The system prompt in `server.js` (`SYSTEM_PROMPT`) is the actual "brain" of
the agent — its philosophy, the coaching framework it uses, and its tone.
Changing what the agent is like is a copy-editing job in that one string, not
a code change.
