import { config } from 'dotenv'

// .env holds the working credentials for this project; .env.local overrides it
// if present. Both are gitignored.
config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })
