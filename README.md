# Query to HTML

Type a search query. Get ten real web pages saved as HTML files in a fresh folder. Download the whole folder as a ZIP if you want.

That is the whole app.

## The idea in one sentence

You type a question, and the app answers with a folder of ten saved web pages plus a ZIP you can carry away.

## What you need
- **Node.js 18 or newer.** Check with `node --version`
You do not need an API key for normal use. You do not need a paid account. You do not need to install any packages — the app uses only what Node.js already includes. An official search API is optional and is mainly useful on a hosted server, where search engines often block automated requests.

## Run it on your computer
Open a terminal in this folder and type:

```bash
node app.js
```

Then open your browser and go to:

```
http://localhost:3000
```

If port 3000 is already busy, give it another port:

```bash
# macOS / Linux
PORT=4000 node app.js

# Windows PowerShell
$env:PORT=4000; node app.js
```

Then open `http://localhost:4000` instead.

## The two screens

The app has exactly two screens. Nothing else.

### Screen 1 — Search

This is where you work.

- A box for your query, plus the number of results, search source, and timeout.
- A short list of **Recent searches** under the query box. Click a chip to refill the box, or Clear to remove the list.
- A **Placement** select: `New folder each run` or `Directly in chosen folder`.
- An **Output** select: `ZIP only`, `HTML files only`, or `HTML files and ZIP`. ZIP only is the default.
- A **Choose folder** button. It opens your operating system's own folder dialog on Windows or macOS. The chosen path is shown next to the button. If no dialog is available, a text box appears so you can type a path instead.
- A **Run** button.
- A progress line, like `Fetching 4/10…`, so you know it is alive. A **Stop this run** button cancels it at a safe point. If files with the same names already exist, the run pauses and asks what to do.
- A list of the saved files with a status for each one. A failed page still gets a small stub file, so the count stays at ten.
- A **Retry failed pages** button when any file failed. It uses the saved URLs and tries only those pages again.
- A search box that looks inside the saved HTML files and shows short snippets linking straight to the matching file.
- A **Download ZIP** button, shown only when your Output setting includes a ZIP.
- An **Open folder** button that reveals the run in Explorer or Finder on a desktop machine.
- A **Re-run this query** button that repeats the last search with the same settings, and a **New search** button.
- A **Settings** link.

### Screen 2 — Settings

This is where you decide how the app behaves. The choices are saved in your browser, so they are still there next time.

| Setting | What it does | Default |
| --- | --- | --- |
| Base folder | Where new run folders are created | `E:\query-to-html\downloads` |
| Ask location each run | Shows the Save location box before every run | on |
| Auto-use last folder | Remembers the folder and skips the question | off |
| Results per run | How many pages to save | 10 |
| Search source | Where results come from: Google with DuckDuckGo fallback, one engine only, or an official API | Google with DuckDuckGo fallback |
| API provider | Google Custom Search, Brave Search, or SerpAPI | Google Custom Search |
| API key | Key for the chosen API, kept only in this browser | empty |
| Search engine ID | The `cx` value, needed only by Google Custom Search | empty |
| Timeout | How long to wait on one slow page | 15 seconds |
| Save manifest.json | Writes a small report of the run | on |
| Add base tag | Keeps relative links and images working offline | on |
| Auto-download ZIP | Starts the ZIP download when a run finishes, if the Output includes a ZIP | off |

"Auto-use last folder" wins over "Ask location each run" when both are on. Think of it as saying: stop asking, you already know where to put things.

Placement and Output are deliberately not here. They sit on the Search screen next to your query, because they are choices you may want to change from one run to the next.

## What happens when you press Run

Here is the whole story, in order.

1. The app reads your query, your chosen folder, and your Placement and Output choices.
2. It asks Google for results. If Google shows a CAPTCHA or refuses, it tries DuckDuckGo instead, without bothering you.
3. It collects ten different page addresses. If the first results page does not give ten, it asks for one more page.
4. For each address, it downloads the raw HTML with a normal browser identity, follows redirects, and stops after 15 seconds or 5 MB. Nothing is executed, and no scripts on those pages are run.
5. It decides the exact file names it will use, then checks whether any of them already exist. This check only matters in direct placement; a new run folder is empty by definition.
6. If names are taken, the run pauses and shows you one list of them. You answer once for all: **Save with new name**, **Overwrite**, or **Skip**. If you do not answer in time, it saves with new names so nothing is destroyed.
7. It writes the HTML files. A small `<base>` tag is added so pictures and links that use relative paths still point to the right place when you open a file offline. It also writes `manifest.json` unless you turned that off.
8. If your Output includes a ZIP, it builds the archive and saves a copy beside the files. The screen then shows the files and offers the ZIP button when relevant.

One failed page does not ruin the run. You still get ten files, and the manifest tells you which one could not be fetched. The **Retry failed pages** button later tries just those URLs again and updates the manifest.

If you chose an official API in Settings, step 2 uses that service instead. The key travels from the browser to the server and is never included in a result or a saved file. If the API fails or returns nothing, the app falls back to Google and DuckDuckGo and writes the reason into the notes shown on the results screen.

## Where the files go

With **New folder each run**, a run looks like this:

```
E:\query-to-html\downloads\
└── typescript-generics_20261124-143022\
    ├── 01-typescript-lang-org.html
    ├── 02-example-com.html
    ├── ...
    ├── 10-last-site-io.html
    ├── manifest.json
    └── typescript-generics_20261124-143022.zip
```

The folder name has two parts. The first part is your query, cleaned up so it is safe to use as a name. The second part is the date and time down to the second. Run the same query twice and you still get two different folders.

With **Directly in chosen folder**, there is no new subfolder and no ZIP unless you ask for one:

```
E:\my-pages\
├── 01-typescript-lang-org.html
├── 02-example-com.html
├── ...
├── 10-last-site-io.html
└── manifest.json
```

Because files from different runs share one folder, this is the mode where the app asks what to do with a name that already exists. If you choose **Save with new name**, the second file becomes `01-typescript-lang-org-2.html`.

## A short note about search engines

Google does not like programs that search on its behalf. If it thinks you are a robot, it shows a CAPTCHA instead of results. That is normal, and it is not a bug in this app.

So the app tries Google first. If Google blocks the request, the app quietly switches to DuckDuckGo's simple HTML results. You still get ten pages, just from a different search engine. The screen tells you which source was used, so you are never confused about where the links came from.

If you want only one source, change **Search source** in Settings. If you later need guaranteed Google results, a paid search API could be added to the search function. The app does not use one today, which is why it stays free.

## About HTML in this project

You will not find an `.html` file in this repository. That is intentional, and it is worth understanding.

The app has a real, visual interface — a page with inputs, buttons, progress, and a settings screen. That interface is written in HTML, but it lives inside `app.js` as a template string. Node.js serves that string to your browser when you open `http://localhost:3000`. Your browser sees ordinary HTML and draws the two screens. You never have to open an HTML file to use the app.

Keeping the HTML inside `app.js` gives us one source file to run and one thing to copy around. It also means there is no build step and no second file to keep in sync with the server.

If you ever want to change how the interface looks, open `app.js` and find the page template near the top. Everything between its backticks is the page your browser sees: the CSS is in a `<style>` block and the button logic is in a `<script>` block at the bottom of that same string. Change it there, save, restart the server, and refresh the browser.

So: HTML is used for the interface, but no separate HTML file is required, and none is used to run the project.

## Running it for free on the internet

You can run this on your own machine for free, forever. You can also put it on the internet for free. Both are fine, but they are not the same.

On your own machine, the app can write into folders you choose on your computer. That is the full version of the feature.

Once the app is hosted somewhere else, it writes to that server's disk, not to your computer. There is no screen on the server, so the native folder dialog cannot open; the page shows a text box instead, and the folder you type means a folder on the server. You still get everything through the **Download ZIP** button when your Output setting includes a ZIP. Search engines also block cloud addresses more often than home addresses, so the DuckDuckGo fallback earns its keep.

A simple free route is Render's free web service:

1. Push this repository to GitHub.
2. On Render, choose **New → Web Service** and select the repository.
3. Leave the runtime as Node, leave the build command empty, and use `npm start` as the start command.
4. Add a `PORT` environment variable only if the host does not set one for you.
5. Deploy, then open the address Render gives you.

For an always-on machine with a real disk, Oracle Cloud's Always Free virtual machine is another option. It asks more of you — SSH, a firewall, and HTTPS setup — but it behaves like a small server you control. It never falls asleep, which Render's free tier does.

Free plans change. Check the provider's current page before you commit to one.

## How the code is put together

Small pieces, each with one job:

- **`app.js`** — the entire application. It holds the page template, the HTTP server, the search, the page fetcher, the file writer, and the ZIP builder. Functions are kept small on purpose so you can read one at a time.
- **`package.json`** — a start script and nothing else. It tells a host how to launch the app. It has no dependencies.

The ZIP is built by Node itself, not by an operating-system command. That means the same file works on Windows, macOS, and Linux without changes.

Your settings live in the browser's local storage. There is no database and no account to create.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `EADDRINUSE` | Another program owns port 3000. Use the `PORT` trick shown above. |
| A folder dialog message says none is available | You are on a system without a native dialog, or the app is hosted. Type a folder path in the box that appears. |
| The run pauses with a list of file names | Those files already exist in direct placement mode. Choose one answer for all of them. |
| A CAPTCHA message | Google blocked this run. Wait a moment and try again, or pick DuckDuckGo in Settings. |
| A file says "could not fetch" | That website refused the request. The manifest lists it. Try the query again later. |
| The ZIP looks empty | Wait until the run finishes before downloading. Build it again with the button. |
| Fewer than ten files | Check Results per run in Settings; it may have been changed. |

## Where to go next

Read `app.js` from top to bottom once. It is one file, and the order is the same order as this README: settings first, then search, then saving, then the ZIP, then the server that ties it together. When you want to change something, find the matching section and change only that piece.
