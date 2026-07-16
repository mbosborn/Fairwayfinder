# FairwayFinder — Setup Guide (start to finish)

You're going to end up with a real website like `fairwayfinder.vercel.app` that:
- shows a live leaderboard your friends can watch from any phone
- updates scores live when anyone taps **Refresh scores** — a counter shows how many of the 20 daily pulls are left so nobody runs it dry
- lets just you and Brian edit the teams (everyone else can only watch)
- already knows which tournament is happening, with the right purse

**Total time: about 20 minutes. There's no coding — it's all clicking buttons and pasting.**

You'll make three free accounts: **GitHub** (stores the code), **Supabase** (the database), and **Vercel** (puts it online). Plus one free **RapidAPI** key for live golf scores. All free, no credit card.

Have this folder handy — it contains everything you'll upload.

---

## Part 1 — Put the code on GitHub (5 min)

GitHub is where your app's code lives. Vercel reads it from here.

1. Go to **github.com** and click **Sign up** (or sign in). Use your email, pick a username.
2. Once logged in, click the **+** in the top-right corner → **New repository**.
3. Repository name: type `fairwayfinder`. Leave everything else default. Make sure **Public** is selected. Click **Create repository**.
4. On the next page, click the link that says **uploading an existing file** (it's in the line "…or upload an existing file").
5. Open this `fairwayfinder` folder on your computer. Select **all the files and folders inside it** (the `api` folder, the `public` folder, `package.json`, `vercel.json`, `supabase-setup.sql`, and this guide) and **drag them into the GitHub upload box.**
6. Wait for them to finish uploading, then click the green **Commit changes** button.

Done — your code is on GitHub. Leave this tab open.

---

## Part 2 — Create the database on Supabase (5 min)

Supabase stores your teams and scores, and pushes live updates to everyone watching.

1. Go to **supabase.com** → **Start your project** → sign in with GitHub (one click).
2. Click **New project**.
   - **Name:** `fairwayfinder`
   - **Database Password:** click **Generate a password**, then copy it somewhere safe (you won't need it often, but keep it).
   - **Region:** pick the one closest to you.
   - Click **Create new project**. Wait ~2 minutes while it sets up.
3. When it's ready, look at the left sidebar and click the **SQL Editor** icon (looks like a terminal/database).
4. Click **+ New query**. Open the file **`supabase-setup.sql`** from this folder, copy everything in it, and paste it into the big box.
5. Click the green **Run** button (bottom-right). You should see "Success." This created your data table.
6. Now get your two keys. In the left sidebar, click the **gear/Settings** icon → **API**.
   - Copy the **Project URL** (looks like `https://abcd1234.supabase.co`) — save it as **SUPABASE_URL**
   - Under "Project API keys," copy the **`anon` `public`** key — save it as **SUPABASE_ANON_KEY**
   - Copy the **`service_role` `secret`** key — save it as **SUPABASE_SERVICE_KEY** (keep this one private — it's like a master key)

Keep these three values in a note. You'll paste them in Part 4.

---

## Part 3 — Get your free live-scores key (3 min)

This is what feeds live golf scores into your app.

1. Go to **rapidapi.com** → **Sign Up** (sign in with Google/GitHub is fastest).
2. In the search bar at the top, type **Live Golf Data** and click the result by **slashgolf**.
3. Click the **Subscribe to Test** button (or the **Pricing** tab) → choose the **Basic / Free** plan → **Subscribe**. (Free gives 20 score-pulls per day. Since scores only update when you tap the button, a handful per round is plenty — no card needed.)
4. Go back to the **Endpoints** tab. On the right side, find the code box and look for **`X-RapidAPI-Key`**. Copy that long value — save it as **RAPIDAPI_KEY**.

Now you have all the secret values you need.

---

## Part 4 — Put it online with Vercel (5 min)

Vercel takes your GitHub code and turns it into a live website.

1. Go to **vercel.com** → **Sign Up** → **Continue with GitHub** (one click).
2. On your dashboard, click **Add New… → Project**.
3. You'll see your `fairwayfinder` repository in the list. Click **Import** next to it.
4. Before clicking Deploy, expand the **Environment Variables** section. This is where your secret values go. Add each of these as a **Name / Value** pair (type the name exactly, paste the value):

   | Name | Value |
   |------|-------|
   | `SUPABASE_URL` | your Project URL from Part 2 |
   | `SUPABASE_SERVICE_KEY` | your service_role secret key from Part 2 |
   | `RAPIDAPI_KEY` | your key from Part 3 |
   | `ADMIN_KEY` | **make up a password** here — this is what you and Brian type to edit teams. Something like `birdie2026`. |

5. Click **Deploy**. Wait ~1 minute. You'll get a "Congratulations" screen with your live link (like `fairwayfinder.vercel.app`).

**One last step** — the front page needs the two *public* Supabase values baked in:

6. In your GitHub `fairwayfinder` repo, open the **`public`** folder → click **`index.html`** → click the **pencil icon** (Edit).
7. Near the top of the `<script>` section you'll see two lines:
   ```
   const SUPABASE_URL = "__SUPABASE_URL__";
   const SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";
   ```
   Replace `__SUPABASE_URL__` with your real Project URL, and `__SUPABASE_ANON_KEY__` with your **anon public** key (the non-secret one). Keep the quotes.
8. Click **Commit changes**. Vercel automatically rebuilds in ~30 seconds.

**You're live.** 🎉

---

## How to use it

**Your two links** (same site, different endings):

- **Watch link (send to friends):** `https://fairwayfinder.vercel.app`
  They can see the live leaderboard and grid. They can't edit anything.

- **Admin link (just you + Brian):** `https://fairwayfinder.vercel.app/#admin`
  Adds a **Teams** tab. The first time you click it, type your `ADMIN_KEY` password. Then edit teams and hit **Save changes** — every watcher's screen updates instantly.

**Each tournament:**
1. The app already knows the current event and purse — it auto-detects from the schedule. You don't set it.
2. On the admin link, open **Teams**, swap in everyone's new picks, **Save changes**.
3. That's it. During play, anyone can tap **Refresh scores** to pull the latest — the **X/20** counter in the header ticks down with each pull and resets at midnight. A few pulls per round (after each round and the cut) leaves plenty of headroom.

**When THE Open comes around in a few weeks:** just open the admin link, replace the picks, save. The event name, course, purse, and live scores all switch over automatically.

---

## If something looks off

- **Scores not updating?** Tap **Refresh scores**. If it still says "no scores yet," the tournament may not have started, or the day's 20 pulls are used up (the counter shows **0/20** and resets at midnight). The leaderboard fills in once round 1 begins.
- **Name shows as MC but shouldn't?** The leaderboard spells a name differently than your pick. Open Teams and match the spelling (e.g. use `Ludvig Aberg`). Accents and `Last, First` are handled automatically.
- **Forgot the admin password?** It's the `ADMIN_KEY` you set in Vercel. Change it anytime: Vercel → your project → **Settings → Environment Variables** → edit `ADMIN_KEY` → then **Deployments → … → Redeploy**.
- **Want a nicer web address?** Vercel → project → **Settings → Domains** lets you add a custom domain if you ever buy one.

That's everything. Questions on any step — just ask.
