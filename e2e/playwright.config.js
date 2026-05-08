// Single-purpose Playwright config: hits the Spring Boot dev server on
// http://localhost:8080. Doesn't auto-start it — caller is responsible for
// `./gradlew bootRun` first. Headless Chromium only.
module.exports = {
    testDir: '.',
    testMatch: /.*\.spec\.js$/,
    fullyParallel: false,
    workers: 1,
    timeout: 30_000,
    expect: { timeout: 5_000 },
    reporter: [['list']],
    use: {
        baseURL: 'http://localhost:8080',
        headless: true,
        viewport: { width: 1280, height: 900 },
        screenshot: 'only-on-failure',
        video: 'off',
        trace: 'retain-on-failure'
    },
    projects: [
        {
            name: 'chromium',
            use: { browserName: 'chromium' }
        }
    ]
};
