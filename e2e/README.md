# DisC wizard end-to-end tests

Playwright-driven smoke tests for the wizard UI. Verifies that the demo seed renders, the 4-step wizard navigates, the fragment composer (alt / opt / par / loop / while / for-each) inserts the right rows, and the emitted PlantUML contains the expected keywords.

## Run

You need **two terminals**: `./gradlew bootRun` blocks until you Ctrl-C it.

**Terminal 1** (leave running):

```bash
./gradlew bootRun
```

Wait for `Started DesignIsCodeApplication`. Then in **Terminal 2**:

```bash
cd e2e
npm install                       # first time only
npx playwright install chromium   # first time only
npx playwright test
```

When done, Ctrl-C Terminal 1 to stop the app.

Headed (visible browser) for debugging: `npm run test:headed`.

Screenshots from the passing run land in [e2e/screenshots/](screenshots/). Failure artifacts (screenshot + trace) land in `e2e/test-results/`. Both directories are gitignored.

## Why a separate package.json

The app itself is Java/Gradle; pulling Playwright into the root would mix two unrelated dependency trees. The `e2e/` folder is self-contained — delete it and nothing in the app changes.
