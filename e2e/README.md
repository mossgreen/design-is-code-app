# DisC wizard end-to-end tests

Playwright-driven smoke tests for the wizard UI. Verifies that the demo seed renders, the 4-step wizard navigates, the fragment composer (alt / opt / par / loop / while / for-each) inserts the right rows, and the emitted PlantUML contains the expected keywords.

## Run

```bash
# 1. Start the Spring Boot app (from the repo root)
./gradlew bootRun

# 2. In another shell, run the suite
cd e2e
npm install         # first time only
npx playwright install chromium   # first time only
npx playwright test
```

Headed (visible browser) for debugging: `npm run test:headed`.

Screenshots from the passing run land in [e2e/screenshots/](screenshots/). Failure artifacts (screenshot + trace) land in `e2e/test-results/`. Both directories are gitignored.

## Why a separate package.json

The app itself is Java/Gradle; pulling Playwright into the root would mix two unrelated dependency trees. The `e2e/` folder is self-contained — delete it and nothing in the app changes.
