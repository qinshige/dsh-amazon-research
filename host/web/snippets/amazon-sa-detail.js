(() => {
  const clean = (value) => String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  const byId = (id) => document.getElementById(id);
  // 价格：#corePrice_feature_div / .a-price / buybox 价格块
  const priceNodes = [
    byId('corePrice_feature_div'),
    byId('corePriceDisplay_desktop_feature_div'),
    byId('apex_desktop'),
    document.querySelector('#priceblock_ourprice, #priceblock_dealprice, .priceToPay .a-offscreen, .a-price .a-offscreen, .a-color-price'),
  ].filter(Boolean);
  let priceText = null;
  for (const node of priceNodes) {
    const offscreen = node.querySelector ? node.querySelector('.a-offscreen') : null;
    const candidate = clean((offscreen && offscreen.textContent) || node.textContent);
    if (candidate && /\d/.test(candidate)) { priceText = candidate; break; }
  }
  // 评分与评论数（阿语站标签为「من 5 نجوم」）
  const ratingEl = document.querySelector('#acrPopover [title*="out of 5"], #acrPopover [title*="من 5"], #acrPopover [title*="نجوم"], [data-hook="rating-out-of-text"], #averageCustomerReviews .a-icon-alt');
  const ratingTitle = ratingEl ? clean(ratingEl.getAttribute('title') || ratingEl.textContent) : null;
  const reviewEl = document.querySelector('#acrCustomerReviewText, #averageCustomerReviews .a-size-base, [data-hook="total-review-count"]');
  const reviewCount = reviewEl ? clean(reviewEl.textContent) : null;
  // 品牌
  const brandEl = document.querySelector('#bylineInfo, #brand, .po-brand .a-link-normal');
  // 卖家与配送
  const sellerEl = document.querySelector('#sellerProfileTriggerId, #merchant-info .a-link-normal, #tabular-buybox .tabular-buybox-text');
  const shipsEl = document.querySelector('#fulfillerInfoFeature_feature_div .offer-display-feature-text, #tabular-buybox .tabular-buybox-text');
  // 库存与交付
  const availability = document.querySelector('#availability span, #availability');
  // 商品属性表（尺寸、重量、材质等）
  const attributes = {};
  for (const row of document.querySelectorAll('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, .prodDetTable tr')) {
    const key = clean((row.querySelector('th') || {}).textContent);
    const value = clean((row.querySelector('td') || {}).textContent);
    if (key && value) attributes[key] = value;
  }
  const bullets = [];
  for (const item of document.querySelectorAll('#feature-bullets li')) {
    const text = clean(item.textContent);
    if (text) bullets.push(text);
  }
  // 尺寸与重量（属性表常见键名）
  const pick = (keys) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (keys.some((candidate) => key.includes(candidate))) return value;
    }
    return null;
  };
  const dimensions = pick(['Package Dimensions', 'Product Dimensions', 'Item Dimensions', 'الأبعاد', 'dimensioni']);
  const weight = pick(['Item Weight', 'Product Weight', 'Package Weight', 'الوزن', 'weight']);
  const material = pick(['Material', 'Fabric Type', 'الخامة', 'مادة']);
  const bestSeller = clean((document.querySelector('#detailBullets_feature_div .a-list-item') || {}).textContent);
  const title = clean((byId('productTitle') || document.querySelector('h1') || {}).textContent);
  return JSON.stringify({
    url: location.href,
    title,
    priceText,
    ratingText: ratingTitle,
    reviewText: reviewCount,
    brand: clean((brandEl || {}).textContent),
    seller: clean((sellerEl || {}).textContent),
    shipsFrom: clean((shipsEl || {}).textContent),
    availability: clean((availability || {}).textContent),
    dimensions,
    weight,
    material,
    attributes,
    bullets: bullets.slice(0, 12),
    bestSellerText: bestSeller,
  });
})()
