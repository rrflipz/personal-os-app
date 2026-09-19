// server.js
//
// This is the whole backend. Read it top to bottom -- it's organized
// as: setup -> auth helpers -> auth routes -> chat route -> payment routes.
//
// The one rule this file exists to enforce: the Anthropic API key
// NEVER goes to the browser. Every chat message goes user -> our
// server -> Anthropic -> our server -> user. That's what makes the
// paywall actually enforceable (a browser-only version can't gate
// anything, since anyone can just read the key out of the page source).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const Stripe = require('stripe');
const rateLimit = require('express-rate-limit');
const { Resend } = require('resend');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const CLIENT_URL = process.env.CLIENT_URL || `http://localhost:${PORT}`;
const FREE_MESSAGE_LIMIT = parseInt(process.env.FREE_MESSAGE_LIMIT || '15', 10);
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Personal OS <noreply@getpersonalos.com>';

if (!JWT_SECRET || !ANTHROPIC_API_KEY) {
  console.error('Missing JWT_SECRET or ANTHROPIC_API_KEY in your .env file. See .env.example.');
  process.exit(1);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia' }) : null;
// If RESEND_API_KEY isn't set, password reset silently no-ops (logs instead
// of sending) rather than crashing the whole app -- handy for local dev
// where you may not want to wire up real email.
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// --- Stripe webhook needs the RAW body, so it must be registered
// before express.json() runs on everything else. ---
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  handleStripeEvent(event)
    .then(() => res.json({ received: true }))
    .catch((err) => {
      console.error('Error handling Stripe webhook event:', err);
      // We already have the event; tell Stripe we got it so it doesn't
      // keep retrying forever, but log it so we notice the failure.
      res.json({ received: true });
    });
});

async function handleStripeEvent(event) {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    if (userId) {
      await db.updateUser(userId, {
        isPro: true,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
      });
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const match = await db.findUserByStripeSubscriptionId(subscription.id);
    if (match) {
      await db.updateUser(match.id, { isPro: false });
    }
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Rate limiting ----------
// Without this, one script (or one person hammering their browser's
// refresh/send button) can spam the Anthropic API through our server --
// that runs up your API bill fast, and unusual traffic patterns like that
// are exactly what got the Anthropic account flagged before.

// Chat is the expensive one (it calls Anthropic). Keyed per logged-in user
// so one account being abusive doesn't block anyone else.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 messages/minute is generous for a real conversation, not for a script
  keyGenerator: (req) => (req.user ? req.user.id : req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You're sending messages a little too fast. Give it a moment and try again." },
});

// Signup/login are cheap to run but are exactly what a bot would hammer to
// spam-create accounts or brute-force a password. Keyed per IP since there's
// no logged-in user yet at this point.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// ---------- Auth helpers ----------

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.findUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'Account not found.' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired, please log in again.' });
  }
}

function publicUser(user) {
  // never send the password hash or internal ids to the browser
  return {
    email: user.email,
    isPro: user.isPro,
    freeMessagesUsed: user.freeMessagesUsed,
    freeMessageLimit: FREE_MESSAGE_LIMIT,
    profile: user.profile,
  };
}

// ---------- Auth routes ----------

app.post('/api/signup', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and an 8+ character password are required.' });
  }
  if (await db.findUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.createUser({
    id: crypto.randomUUID(),
    email,
    passwordHash,
    isPro: false,
    freeMessagesUsed: 0,
    profile: { archetype: null, learning: null, strengths: null, focus: null },
    conversation: [],
    createdAt: new Date().toISOString(),
  });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const user = await db.findUserByEmail(email || '');
  if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: publicUser(req.user), conversation: req.user.conversation });
});

// ---------- Password reset ----------
// We never store the raw reset token or email it in plain, recoverable form
// beyond the link itself -- only a hash of it goes in the database, so
// nobody who reads the database (or a backup of it) can use it to take over
// an account. The link itself is the only place the real token exists,
// and it expires in an hour.

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  const genericResponse = { message: "If an account exists for that email, we've sent a reset link." };

  const user = email ? await db.findUserByEmail(email) : null;
  // Deliberately respond the same way whether or not the account exists --
  // otherwise this endpoint becomes a way for anyone to check which emails
  // have accounts on your app.
  if (!user) return res.json(genericResponse);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.updateUser(user.id, { resetTokenHash: tokenHash, resetTokenExpires: expires });

  const resetLink = `${CLIENT_URL}/reset-password.html?token=${rawToken}`;

  if (!resend) {
    // No email service configured (e.g. local dev without RESEND_API_KEY) --
    // log the link instead of failing, so you can still test the flow.
    console.log(`[password reset] No RESEND_API_KEY set. Reset link for ${user.email}: ${resetLink}`);
    return res.json(genericResponse);
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: user.email,
      subject: 'Reset your Personal OS password',
      html: `
        <p>Someone (hopefully you) asked to reset the password on your Personal OS account.</p>
        <p><a href="${resetLink}">Click here to set a new password</a>. This link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email -- your password won't change.</p>
      `,
    });
  } catch (err) {
    console.error('Failed to send password reset email:', err);
    // Still return the generic success response -- we don't want to leak
    // to the caller whether sending failed, and the token is already saved
    // so a retry (or you checking the Render logs) can still work.
  }

  res.json(genericResponse);
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'A valid token and an 8+ character new password are required.' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await db.findUserByResetTokenHash(tokenHash);

  if (!user || !user.resetTokenExpires || new Date(user.resetTokenExpires) < new Date()) {
    return res.status(400).json({ error: 'That reset link is invalid or has expired. Request a new one.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.updateUser(user.id, {
    passwordHash,
    resetTokenHash: null,
    resetTokenExpires: null,
  });

  res.json({ message: 'Your password has been reset. You can now log in.' });
});

// ---------- Chat route (this is where the paywall is enforced) ----------

const SYSTEM_PROMPT = `You are "Personal OS" — an adaptive AI life-navigation guide. You are not a generic life coach and you never sound like one.

CORE PHILOSOPHY (never deviate):
- You guide, you do not control. You teach people HOW to think, never WHAT to think.
- You amplify the person's own ideas rather than replacing their agency. Your goal is that they become less dependent on you over time, not more.
- You are non-judgmental. Life isn't perfect, schedules slip, people contradict themselves — that's normal, not a failure to flag.
- Onboarding is adaptive, not a form. Ask ONE thing at a time, and let what they say shape your next question. Never dump a list of questions on them.
- You are trying to learn the person's archetype: their learning style (visual/analytical/kinesthetic), whether they need structure or freedom, whether they're creative or systematic, and how their mind naturally works.
- You cover: financial literacy, purpose/path discovery, daily organization (without rigidity), mindset and limiting beliefs, personal brand, and critical thinking — but only bring these up when the conversation naturally opens the door, never as a checklist.

FRAMEWORK YOU DRAW ON (use naturally, don't recite):
Self-discovery angle: What occupations exist that they've never considered? What are their strengths and weaknesses? Who are they trying to become? What direction are they taking? What have they actually done? What do they pursue naturally without being told to?
Systems-thinking angle (domain-agnostic — applies to a teacher, tradesman, artist, or entrepreneur equally): Why would someone trust them over the next person? What value do they actually offer? What tools would let them leverage their time? How do they build something that scales — training others, incentives, retention, what makes people stay vs. chase quick money?
Underlying belief: no path is mediocre if the person understands why they're doing it. A teacher building a legacy is exactly as legitimate and scalable as an entrepreneur. Your job is to help them see the systems and leverage points in whatever THEY want to build — not to push them toward business/hustle culture.

CONVERSATION STYLE:
- Warm, direct, a little sharp — like someone who sees patterns clearly and respects the person enough to be honest rather than vague and encouraging.
- Never therapy-speak, never corporate-coach language. Short paragraphs. Plain words.
- End almost every message with exactly one question that moves the conversation forward.
- If they share something vulnerable or stuck, acknowledge it plainly in one sentence, don't linger on validation, then move toward the next useful question.

PROFILE TRACKING (mechanical, not conversational):
After you have learned something new and durable about the person in a turn, append a hidden block at the very end of your reply, after your visible message, in EXACTLY this format on its own line:
<<<PROFILE>>>{"archetype":"...", "learning":"...", "strengths":"...", "focus":"..."}<<<END>>>
Only include the keys you have new information for — omit keys you have nothing new to say about. Keep each value under 12 words, written as a plain descriptive phrase (not a full sentence, no leading capital needed). This block is stripped before the person sees your message, so it must add nothing they need to read — never reference it in your visible text. Do not include this block if you learned nothing new that turn.`;

function extractProfileBlock(text) {
  const match = text.match(/<<<PROFILE>>>([\s\S]*?)<<<END>>>/);
  if (!match) return { clean: text, updates: null };
  const clean = text.replace(match[0], '').trim();
  let updates = null;
  try {
    updates = JSON.parse(match[1].trim());
  } catch (e) {
    updates = null;
  }
  return { clean, updates };
}

app.post('/api/chat', authMiddleware, chatLimiter, async (req, res) => {
  const user = req.user;
  const { message } = req.body;

  const isFirstMessage = !message;
  if (!isFirstMessage && !user.isPro && user.freeMessagesUsed >= FREE_MESSAGE_LIMIT) {
    return res.status(402).json({
      error: 'paywall',
      message: `You've used your ${FREE_MESSAGE_LIMIT} free messages. Upgrade to keep going.`,
    });
  }

  const conversation = user.conversation || [];
  const userTurn = isFirstMessage
    ? { role: 'user', content: '[Begin the session. Open the conversation yourself as instructed.]' }
    : { role: 'user', content: message };
  const messagesToSend = [...conversation, userTurn];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: messagesToSend,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', errText);
      return res.status(502).json({ error: 'The AI service had a problem. Try again in a moment.' });
    }

    const data = await response.json();
    const textBlock = data.content.find(b => b.type === 'text');
    const rawText = textBlock ? textBlock.text : '';
    const { clean, updates } = extractProfileBlock(rawText);

    const updatedProfile = updates ? { ...user.profile, ...updates } : user.profile;
    const updatedConversation = [...messagesToSend, { role: 'assistant', content: rawText }];

    const updates_to_user = {
      conversation: updatedConversation,
      profile: updatedProfile,
    };
    if (!isFirstMessage && !user.isPro) {
      updates_to_user.freeMessagesUsed = user.freeMessagesUsed + 1;
    }
    const saved = await db.updateUser(user.id, updates_to_user);

    res.json({
      reply: clean,
      profile: updatedProfile,
      freeMessagesUsed: saved.freeMessagesUsed,
      freeMessageLimit: FREE_MESSAGE_LIMIT,
      isPro: saved.isPro,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong talking to the AI service.' });
  }
});

// ---------- Payment routes ----------

app.post('/api/create-checkout-session', authMiddleware, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(400).json({ error: 'Payments are not configured yet.' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: req.user.id,
      customer_email: req.user.email,
      billing_address_collection: 'required',
      success_url: `${CLIENT_URL}/?upgraded=true`,
      cancel_url: `${CLIENT_URL}/?upgraded=false`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

app.listen(PORT, () => {
  console.log(`Personal OS server running on http://localhost:${PORT}`);
});
