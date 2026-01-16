// monitor.js - Multi-site version - Checks both Airtable and Rockrose
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const nodemailer = require('nodemailer');
const fs = require('fs');

// ===== CONFIGURATION =====
const AIRTABLE_URL = 'https://airtable.com/appsseXTOVx59HC0W/pagcVengefPFQvMZC/form';
const ROCKROSE_URL = 'https://rockrose.com/affordable-availabilities/';
const AIRTABLE_DATA_FILE = 'airtable-data.json';
const ROCKROSE_DATA_FILE = 'rockrose-data.json';

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const EMAIL_RECIPIENT = process.env.EMAIL_RECIPIENT;

// ===== SHARED UTILITIES =====
function loadPreviousListings(filename) {
  try {
    if (fs.existsSync(filename)) {
      const data = fs.readFileSync(filename, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.listings || [];
    }
  } catch (error) {
    console.log(`Starting fresh - no previous data for ${filename}`);
  }
  return [];
}

function saveListings(filename, listings) {
  const data = {
    listings: listings,
    lastChecked: new Date().toISOString()
  };
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
}

async function sendEmail(subject, newListings, sourceUrl, sourceName) {
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
    subject: subject,
    html: `
      <h2>🏠 New Housing at ${sourceName}!</h2>
      <p><strong>Apply NOW before it fills up:</strong></p>
      <ul>
        ${newListings.map(listing => `<li style="font-size:16px; margin:8px 0;">${listing}</li>`).join('')}
      </ul>
      <a href="${sourceUrl}" 
         style="background:#2563eb; color:white; padding:15px 30px; text-decoration:none; 
                border-radius:6px; display:inline-block; margin-top:20px; font-weight:bold; font-size:16px;">
        → Apply Right Now ←
      </a>
      <p style="color:#666; margin-top:20px;">Checked at ${new Date().toLocaleString()}</p>
    `
  });
}

// ===== AIRTABLE CHECKER (your original logic) =====
async function checkAirtable(browser) {
  console.log('\n📋 CHECKING AIRTABLE...');
  const page = await browser.newPage();
  
  try {
    console.log('📄 Loading Airtable form...');
    await page.goto(AIRTABLE_URL, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    await page.waitForTimeout(5000);

    console.log('🖱️  Clicking "+ Add unit" button...');
    await page.click('button:has-text("Add unit"), button:has-text("Add"), button[aria-label*="Add"]').catch(() => {
      return page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const addButton = buttons.find(btn => btn.textContent.includes('Add unit') || btn.textContent.includes('Add'));
        if (addButton) addButton.click();
      });
    });

    await page.waitForTimeout(2000);

    console.log('⌨️  Navigating through all options...');
    await page.evaluate(() => {
      const searchInput = document.querySelector('input[type="text"], input[placeholder*="Search"]');
      if (searchInput) searchInput.focus();
    });
    await page.waitForTimeout(500);
    
    const allListings = new Set();
    let consecutiveSameCount = 0;
    const maxAttempts = 200;
    
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    
    for (let i = 0; i < maxAttempts; i++) {
      const currentText = await page.evaluate(() => {
        const selectors = [
          '[role="option"][data-selected="true"]',
          '[role="option"][aria-selected="true"]',
          '[role="option"][class*="selected"]',
          '[role="option"][class*="active"]',
          '[role="option"][class*="highlight"]'
        ];
        
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) return el.textContent.trim();
        }
        return '';
      });
      
      if (currentText && currentText !== 'Search' && currentText !== 'Select an option' && currentText !== '') {
        if (allListings.has(currentText)) {
          consecutiveSameCount++;
          if (consecutiveSameCount > 2) {
            console.log('  ✓ Captured all Airtable items!');
            break;
          }
        } else {
          consecutiveSameCount = 0;
          allListings.add(currentText);
        }
      }
      
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(100);
    }

    const listings = Array.from(allListings);
    console.log(`✅ Airtable: ${listings.length} listings found`);

    const previousListings = loadPreviousListings(AIRTABLE_DATA_FILE);
    const newListings = listings.filter(listing => !previousListings.includes(listing));

    if (newListings.length > 0) {
      console.log('🚨 NEW AIRTABLE LISTINGS!');
      newListings.forEach(listing => console.log(`  ✅ ${listing}`));
      
      await sendEmail(
        '🚨 NEW Affordable Housing (Airtable)!',
        newListings,
        AIRTABLE_URL,
        'Airtable Form'
      );
      console.log('✅ Email sent for Airtable!');
    } else {
      console.log('✓ No new Airtable listings');
    }

    saveListings(AIRTABLE_DATA_FILE, listings);

  } catch (error) {
    console.error('❌ Airtable Error:', error.message);
    await page.screenshot({ path: 'airtable-error.png' });
  } finally {
    await page.close();
  }
}

// ===== ROCKROSE CHECKER (new) =====
async function checkRockrose(browser) {
  console.log('\n🏢 CHECKING ROCKROSE...');
  const page = await browser.newPage();
  
  try {
    console.log('📄 Loading Rockrose page...');
    await page.goto(ROCKROSE_URL, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    await page.waitForTimeout(3000);

    console.log('🔍 Extracting Rockrose listings...');
    const pageData = await page.evaluate(() => {
      // Check if the "no availability" message is present
      const noAvailabilityText = 'There is currently no affordable housing availability at this time';
      const bodyText = document.body.textContent;
      const hasNoAvailabilityMessage = bodyText.includes(noAvailabilityText);
      
      // If listings exist, they would typically be in article/div containers
      // Look for property cards, listing items, or similar structures
      const potentialSelectors = [
        'article',
        '.property-card',
        '.listing-item',
        '.availability-item',
        '[class*="property"]',
        '[class*="listing"]',
        '[class*="unit"]'
      ];
      
      let items = [];
      for (const selector of potentialSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          // Check if these look like actual listing items (not navigation, etc)
          const possibleListings = Array.from(elements).filter(el => {
            const text = el.textContent.trim();
            // Filter out navigation and small elements
            return text.length > 50 && !text.startsWith('View All') && !text.startsWith('About');
          });
          
          if (possibleListings.length > 0) {
            items = possibleListings.map(el => {
              return el.textContent.trim().replace(/\s+/g, ' ');
            });
            break;
          }
        }
      }
      
      return {
        hasNoAvailabilityMessage: hasNoAvailabilityMessage,
        hasListings: items.length > 0,
        listings: items,
        fullPageText: bodyText.substring(0, 2000) // First 2000 chars for debugging
      };
    });

    const previousListings = loadPreviousListings(ROCKROSE_DATA_FILE);
    const hadNoListingsBefore = previousListings.length === 0 || 
                                 (previousListings.length === 1 && previousListings[0] === '__NO_AVAILABILITY__');

    // CASE 1: "No availability" message is showing
    if (pageData.hasNoAvailabilityMessage) {
      console.log('ℹ️  Rockrose: No listings available (showing "no availability" message)');
      saveListings(ROCKROSE_DATA_FILE, ['__NO_AVAILABILITY__']);
      return;
    }

    // CASE 2: No availability message is GONE but we found listings with our selectors
    if (pageData.hasListings) {
      const listings = pageData.listings;
      console.log(`✅ Rockrose: ${listings.length} listings found with selectors`);
      console.log('Sample:', listings[0]?.substring(0, 100) || 'N/A');

      const newListings = listings.filter(listing => !previousListings.includes(listing));

      if (newListings.length > 0 || hadNoListingsBefore) {
        console.log('🚨 NEW ROCKROSE LISTINGS!');
        newListings.forEach(listing => console.log(`  ✅ ${listing.substring(0, 100)}...`));
        
        await sendEmail(
          '🚨 NEW Affordable Housing (Rockrose)!',
          newListings.length > 0 ? newListings.map(l => l.substring(0, 200)) : ['Listings detected! Check the site now.'],
          ROCKROSE_URL,
          'Rockrose'
        );
        console.log('✅ Email sent for Rockrose!');
      } else {
        console.log('✓ No new Rockrose listings');
      }

      saveListings(ROCKROSE_DATA_FILE, listings);
      return;
    }

    // CASE 3: ⚠️ No availability message is GONE but we couldn't find listings
    // This is the scenario you're worried about - something changed but our selectors failed
    console.log('⚠️  ROCKROSE PAGE CHANGED! "No availability" message is gone but selectors found nothing');
    console.log('🔍 Page preview:', pageData.fullPageText.substring(0, 500));
    
    // If we previously had no listings and now the message is gone, ALERT!
    if (hadNoListingsBefore) {
      console.log('🚨 ALERTING: Page structure changed from "no availability" state!');
      
      await sendEmail(
        '⚠️ ROCKROSE PAGE CHANGED - Manual Check Needed!',
        [
          '⚠️ The "no availability" message disappeared but the script couldn\'t find listings.',
          'The page structure may have changed. Please check manually:',
          'First 500 characters of page: ' + pageData.fullPageText.substring(0, 500)
        ],
        ROCKROSE_URL,
        'Rockrose (Requires Manual Check)'
      );
      console.log('✅ Alert email sent!');
    }
    
    // Save a marker so we know something changed
    saveListings(ROCKROSE_DATA_FILE, ['__PAGE_CHANGED_SELECTORS_FAILED__']);



  } catch (error) {
    console.error('❌ Rockrose Error:', error.message);
    await page.screenshot({ path: 'rockrose-error.png' });
  } finally {
    await page.close();
  }
}

// ===== MAIN FUNCTION =====
async function checkAllSites() {
  console.log(`⏰ Starting checks at ${new Date().toLocaleString()}...`);
  
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath,
    headless: 'new',
  });

  try {
    // Check both sites
    await checkAirtable(browser);
    await checkRockrose(browser);
    
    console.log('\n✅ All checks complete!');
  } catch (error) {
    console.error('❌ Fatal error:', error);
  } finally {
    await browser.close();
  }
}

// Run the checks
checkAllSites().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
