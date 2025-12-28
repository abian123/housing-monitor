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
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath,
    headless: 'new',
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

    // Click the "+ Add" button to open the dropdown
    console.log('🖱️  Clicking "+ Add" button...');
    await page.click('button:has-text("Add"), button[aria-label*="Add"]').catch(() => {
      // Try alternative selectors if the first one fails
      return page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const addButton = buttons.find(btn => btn.textContent.includes('Add'));
        if (addButton) addButton.click();
      });
    });

    // Wait for dropdown to appear
    await page.waitForTimeout(2000);

    // Scroll within the dropdown to load all options - aggressive approach
    console.log('📜 Scrolling to load all options...');
    await page.evaluate(async () => {
      // Find the scrollable dropdown container
      const possibleSelectors = [
        '[role="listbox"]',
        '[role="menu"]',
        '.select-list',
        '[class*="dropdown"]',
        '[class*="menu"]',
        '[class*="list"]',
        'div[style*="overflow"]'
      ];

      let container = null;
      for (const selector of possibleSelectors) {
        const el = document.querySelector(selector);
        if (el && (el.scrollHeight > el.clientHeight)) {
          container = el;
          console.log('Found scrollable container:', selector);
          break;
        }
      }

      if (container) {
        // Scroll incrementally to trigger lazy loading
        const scrollStep = 100;
        const maxScrolls = 50;
        for (let i = 0; i < maxScrolls; i++) {
          container.scrollTop += scrollStep;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Final scroll to absolute bottom
        container.scrollTop = container.scrollHeight;
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.log('No scrollable container found - trying page scroll');
        // Try scrolling the page itself
        window.scrollTo(0, document.body.scrollHeight);
      }
    });

    // Wait for all options to render after scrolling
    await page.waitForTimeout(3000);

    // Look for dropdown options
    console.log('🔍 Looking for dropdown options...');
    const listings = await page.evaluate(() => {
      const options = [];
      
      // Get ALL text content from the dropdown, not just visible items
      const selectors = [
        '[role="option"]',
        'li[role="option"]',
        'div[role="option"]',
        '.select-option',
        '[data-option]'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(`Found ${elements.length} elements with selector: ${selector}`);
          elements.forEach(el => {
            const text = el.textContent.trim();
            // Skip empty or placeholder options
            if (text && 
                text !== '' && 
                text !== 'Search' &&
                text !== 'Select an option' && 
                text !== 'Choose an option') {
              options.push(text);
            }
          });
          if (options.length > 0) {
            break;
          }
        }
      }

      console.log(`Total options found: ${options.length}`);
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
    const removedListings = previousListings.filter(listing => !listings.includes(listing));

    if (newListings.length > 0) {
      // NEW LISTINGS FOUND!
      console.log('🚨🚨🚨 NEW LISTINGS DETECTED! 🚨🚨🚨');
      newListings.forEach(listing => console.log(`  ✅ ${listing}`));
      
      // Send email
      console.log('📧 Sending email notification...');
      await sendEmail(newListings);
      console.log('✅ Email sent successfully!');
    } else if (removedListings.length > 0) {
      // Listings were removed (filled up)
      console.log('⚠️  Some listings were removed (likely filled):');
      removedListings.forEach(listing => console.log(`  ❌ ${listing}`));
      // Don't send email for removals - only for new additions
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
