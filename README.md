# Next Three

Movie recommendations based on watched films, genre preferences, U.S. streaming services, and personal ratings. Movie data and U.S. availability come from TMDB and its JustWatch partnership. A live setup requires your own credentials and appropriate licenses. No catalog covers every film or service, and availability changes.

## Local development

Use Node.js 20 or newer. Put the frontend files in `public/`, then run:

```sh
TMDB_READ_TOKEN=your_server_side_token node server.js
```

Open http://localhost:3000. Alternatively set `TMDB_API_KEY`. Do not put secrets in source control, frontend code, or chat. Without a TMDB credential, the app explains that live data is unavailable. Test the Worker with:

```sh
node --test test/worker.test.mjs
```

## Accounts and persistence

Create a Supabase project. In its SQL editor, run `schema.sql` once to create a profile table protected by row level security. Configure the Google and Facebook providers in Supabase Auth, create the respective OAuth apps with those providers, and set the callback URLs shown by Supabase. Add your app URL and allowed redirects in Supabase Auth URL configuration. Configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the app environment. These values identify the project and are public; never use the Supabase service role key in the browser or Worker. Test sign in, sign out, first time profile migration, and profile isolation using separate test accounts before going live. Without configuration the sign in controls cannot authenticate. Users can still use local preferences when the frontend supports them.

## Cloudflare Worker

The Worker serves the `public/` directory and handles `/api/*` routes. Install or use `wrangler`, sign in to your own Cloudflare account, and review `wrangler.jsonc` before deploying. Set a secret with `npx wrangler secret put TMDB_READ_TOKEN`. Configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` as environment variables if accounts are enabled, then run `npx wrangler deploy`. Configure the deployed URL in Supabase and the login provider dashboards. Deployment creates a publicly reachable service, so verify access, licensing, secrets, and billing before publishing. This project has not been deployed by its authors here.

## Data and privacy

Movie queries use the TMDB API at request time. Recommendation candidates are ranked by selected and liked movies and genre overlap, exclude previously watched and rated films, and are checked against the user's selected U.S. providers and offer types. Suggestions may be fewer than three if matching or availability data is limited. Feedback personalizes the individual user's recommendations; there is no shared learning model. Provider links go to TMDB's watch page rather than a guaranteed direct streaming link. Check the app for TMDB and JustWatch attribution and comply with their current terms. Commercial use may require a separate license. See https://developer.themoviedb.org/docs/faq and https://developer.themoviedb.org/reference/movie-watch-providers.

The Coming of age choice uses TMDB's matching keyword. The theater option uses TMDB's current U.S. theatrical release window; it does not assert that a film is playing near a particular ZIP. A Google search link lets visitors check local showtimes. ZIP codes are stored with the user's other preferences and are included in the Google query only when a visitor opens that link. The site's optional zoom setting is stored on the current device.

A signed in user's profile is read and written with that user's Supabase access token. The backend verifies it through Supabase Auth and never accepts a user ID from the client. The schema's row level security policies restrict access to the token owner. Configure security, account deletion, privacy information, rate limiting, and abuse protection for your deployment before broad public use.
