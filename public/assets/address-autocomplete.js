(function () {
  const registered = new Set();
  let mapsReady;

  function getEl(id) {
    return typeof id === 'string' ? document.getElementById(id) : id;
  }

  function ensureStyles() {
    if (document.getElementById('gb-address-autocomplete-style')) return;
    const style = document.createElement('style');
    style.id = 'gb-address-autocomplete-style';
    style.textContent = `
      .gb-place-wrap{position:relative}
      .gb-place-list{position:absolute;z-index:99999;left:0;right:0;top:100%;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 14px 32px rgba(15,23,42,.18);margin-top:4px;max-height:240px;overflow:auto}
      .gb-place-item{padding:10px 12px;cursor:pointer;border-bottom:1px solid #eef2f7;font-size:13px;color:#0f172a}
      .gb-place-item:last-child{border-bottom:0}
      .gb-place-item:hover,.gb-place-item.active{background:#eff6ff}
      .gb-place-main{font-weight:700}
      .gb-place-sub{color:#64748b;font-size:12px;margin-top:2px}
    `;
    document.head.appendChild(style);
  }

  async function loadMaps() {
    if (window.google?.maps?.places) return window.google;
    if (mapsReady) return mapsReady;
    mapsReady = fetch('/api/maps/config')
      .then((r) => r.json())
      .then((cfg) => {
        if (!cfg.success || !cfg.apiKey) throw new Error(cfg.message || 'Google Maps key missing');
        return new Promise((resolve, reject) => {
          const cb = `__gbPlacesReady_${Date.now()}`;
          window[cb] = () => {
            delete window[cb];
            resolve(window.google);
          };
          const script = document.createElement('script');
          script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.apiKey)}&libraries=places&callback=${cb}`;
          script.async = true;
          script.defer = true;
          script.onerror = () => reject(new Error('Google Maps script failed'));
          document.head.appendChild(script);
        });
      });
    return mapsReady;
  }

  function component(place, type) {
    const part = (place.address_components || []).find((c) => c.types.includes(type));
    return part ? part.long_name : '';
  }

  function fillFields(place, cfg) {
    const address = getEl(cfg.address);
    if (address) address.value = place.formatted_address || place.name || address.value;
    const city = getEl(cfg.city);
    if (city) city.value = component(place, 'locality') || component(place, 'administrative_area_level_3') || component(place, 'postal_town') || city.value;
    const state = getEl(cfg.state);
    if (state) state.value = component(place, 'administrative_area_level_1') || state.value;
    const lat = getEl(cfg.lat);
    const lng = getEl(cfg.lng);
    const loc = place.geometry && place.geometry.location;
    if (lat && loc) lat.value = loc.lat();
    if (lng && loc) lng.value = loc.lng();
    address && address.dispatchEvent(new Event('change', { bubbles: true }));
    city && city.dispatchEvent(new Event('change', { bubbles: true }));
    state && state.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function esc(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function attach(cfg) {
    const address = getEl(cfg.address);
    if (!address || registered.has(address.id || address)) return;
    registered.add(address.id || address);
    ensureStyles();

    const parent = address.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') parent.classList.add('gb-place-wrap');
    address.setAttribute('autocomplete', 'off');

    const list = document.createElement('div');
    list.className = 'gb-place-list';
    list.style.display = 'none';
    parent.appendChild(list);

    let service, places, token, timer;
    const placesNode = document.createElement('div');
    document.body.appendChild(placesNode);

    function hide() {
      list.style.display = 'none';
      list.innerHTML = '';
    }

    async function setup() {
      const google = await loadMaps();
      service = service || new google.maps.places.AutocompleteService();
      places = places || new google.maps.places.PlacesService(placesNode);
      token = token || new google.maps.places.AutocompleteSessionToken();
    }

    function showPredictions(predictions) {
      if (!predictions || !predictions.length) return hide();
      list.innerHTML = predictions.map((p) => `
        <div class="gb-place-item" data-place-id="${p.place_id}">
          <div class="gb-place-main">${esc(p.structured_formatting?.main_text || p.description)}</div>
          <div class="gb-place-sub">${esc(p.structured_formatting?.secondary_text || '')}</div>
        </div>
      `).join('');
      list.style.display = 'block';
      list.querySelectorAll('.gb-place-item').forEach((item) => {
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          selectPlace(item.dataset.placeId);
        });
      });
    }

    async function selectPlace(placeId) {
      await setup();
      places.getDetails({
        placeId,
        sessionToken: token,
        fields: ['formatted_address', 'name', 'address_components', 'geometry']
      }, (place, status) => {
        if (status === window.google.maps.places.PlacesServiceStatus.OK && place) fillFields(place, cfg);
        token = new window.google.maps.places.AutocompleteSessionToken();
        hide();
      });
    }

    address.addEventListener('input', () => {
      clearTimeout(timer);
      const input = address.value.trim();
      if (input.length < 3) return hide();
      timer = setTimeout(async () => {
        try {
          await setup();
          service.getPlacePredictions({
            input,
            sessionToken: token,
            componentRestrictions: { country: 'in' },
            types: ['geocode']
          }, (predictions, status) => {
            if (status !== window.google.maps.places.PlacesServiceStatus.OK) return hide();
            showPredictions(predictions);
          });
        } catch (err) {
          console.warn('Address autocomplete unavailable:', err.message);
          hide();
        }
      }, 250);
    });
    address.addEventListener('blur', () => setTimeout(hide, 180));
  }

  function initKnownFields() {
    [
      { address: 'address', city: 'city', state: 'state', lat: 'latitude', lng: 'longitude' },
      { address: 'ac_address', city: 'ac_city', state: 'ac_state' },
      { address: 'cm_address', city: 'cm_city', state: 'cm_state' },
      { address: 'aef_present_address' },
      { address: 'aef_permanent_address' },
      { address: 'edf_present_address' },
      { address: 'edf_permanent_address' }
    ].forEach(attach);
  }

  window.GeeBharatAddressAutocomplete = { attach, initKnownFields };
  document.addEventListener('DOMContentLoaded', initKnownFields);
  new MutationObserver(initKnownFields).observe(document.documentElement, { childList: true, subtree: true });
})();
