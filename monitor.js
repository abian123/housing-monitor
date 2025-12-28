// monitor.js - Simple version - Email notifications only
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const nodemailer = require('nodemailer');
const fs = require('fs');

// ===== WHAT THIS DOES =====
// 1. Opens the Airtable form
// 2. Looks at the dropdown options
// 3. Compares with what it saw last time
// 4. If something is NEW → sends you an email
// 5. Saves what it saw for next time

const AIRTABLE_URL = 'https://airtable.com/appsseXTOVx59HC0W/shrPuRidwcYcgg5mU';
const DATA_FILE = 'housing-data.json';

// Get email settings from GitHub secrets (you'll set these up in GitHub)
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const EMAIL_RECIPIENT = process.env.EMAIL_RECIPIENT;

// Load what we saw last time
function loadPreviousListings() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.listings || [];
    }
  } catch (error) {
    console.log('Starting fresh - no previous data');
  }
  return [];
}

// Save what we just saw
function saveListings(listings) {
  const data = {
    listings: listings,
    lastChecked: new Date().toISOString()
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Send email notification
async function sendEmail(newListings) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD
    }
  });

  await transporter.sendMail({
    from: EMAIL_USER,
    to: EMAIL_RECIPIENT,
    subject: '🚨 NEW Affordable Housing Available!',
    html: `
      <h2>🏠 New Housing Just Added!</h2>
      <p><strong>Apply NOW before it fills up:</strong></p>
      <ul>
        ${newListings.map(listing => `<li style="font-size:16px; margin:8px 0;">${listing}</li>`).join('')}
      </ul>
      <a href="${AIRTABLE_URL}" 
         style="background:#2563eb; color:white; padding:15px 30px; text-decoration:none; 
                border-radius:6px; display:inline-block; margin-top:20px; font-weight:bold; font-size:16px;">
        → Apply Right Now ←
      </a>
      <p style="color:#666; margin-top:20px;">Checked at ${new Date().toLocaleString()}</p>
    `
  });
}

// Main function - check for new listings
async function checkForNewListings() {
  console.log(`⏰ Checking at ${new Date().toLocaleString()}...`);
  
  // Open a browser
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  const page = await browser.newPage();
  
  try {
    // Go to the Airtable form
    console.log('📄 Loading form...');
    await page.goto(AIRTABLE_URL, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });

    // Wait for it to fully load
    await page.waitForTimeout(5000);

    // Look for dropdown options
    console.log('🔍 Looking for dropdown options...');
    const listings = await page.evaluate(() => {
      const options = [];
      
      // Try different ways to find the dropdown
      const selectors = [
        'select option',
        '[role="option"]',
        'select[name*="address"] option',
        'select[name*="location"] option',
        'select[name*="building"] option',
        'select[name*="property"] option'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach(el => {
            const text = el.textContent.trim();
            // Skip empty or placeholder options
            if (text && 
                text !== '' && 
                text !== 'Select an option' && 
                text !== 'Choose an option') {
              options.push(text);
            }
          });
          if (options.length > 0) break;
        }
      }

      // Remove duplicates
      return [...new Set(options)];
    });

    console.log(`📊 Found ${listings.length} total listings`);

    if (listings.length === 0) {
      console.log('⚠️  Could not find any dropdown options');
      await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });
      await browser.close();
      return;
    }

    // Compare with what we saw before
    const previousListings = loadPreviousListings();
    const newListings = listings.filter(listing => !previousListings.includes(listing));

    if (newListings.length > 0) {
      // NEW LISTINGS FOUND!
      console.log('🚨🚨🚨 NEW LISTINGS DETECTED! 🚨🚨🚨');
      newListings.forEach(listing => console.log(`  ✅ ${listing}`));
      
      // Send email
      console.log('📧 Sending email notification...');
      await sendEmail(newListings);
      console.log('✅ Email sent successfully!');
    } else {
      console.log('✓ No changes - all listings are the same');
    }

    // Save for next time
    saveListings(listings);

  } catch (error) {
    console.error('❌ Error:', error.message);
    await page.screenshot({ path: 'error-screenshot.png' });
  } finally {
    await browser.close();
  }
}

// Run the check
checkForNewListings().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});