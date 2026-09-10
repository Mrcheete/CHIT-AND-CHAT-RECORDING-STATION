document.addEventListener("DOMContentLoaded", () => {
  CCBrand.renderHeader("settings.html");
  let brand = CCBrand.loadBrand();

  function fill() {
    document.getElementById("b-name").value = brand.name;
    document.getElementById("b-primary").value = brand.primary;
    document.getElementById("b-secondary").value = brand.secondary;
    document.getElementById("b-accent").value = brand.accent;
    document.getElementById("b-ink").value = brand.ink;
    document.getElementById("logo-preview").src = brand.logo;
  }
  fill();

  document.getElementById("b-logo").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      brand.logo = ev.target.result;
      document.getElementById("logo-preview").src = brand.logo;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("btn-save-brand").addEventListener("click", () => {
    brand = {
      name: document.getElementById("b-name").value || CCBrand.DEFAULT_BRAND.name,
      primary: document.getElementById("b-primary").value,
      secondary: document.getElementById("b-secondary").value,
      accent: document.getElementById("b-accent").value,
      ink: document.getElementById("b-ink").value,
      logo: brand.logo,
    };
    CCBrand.saveBrand(brand);
    CCBrand.applyBrand(brand);
    CCBrand.renderHeader("settings.html");
    CCBrand.toast("Brand kit saved — applied everywhere.");
  });

  document.getElementById("btn-reset-brand").addEventListener("click", () => {
    brand = { ...CCBrand.DEFAULT_BRAND };
    CCBrand.saveBrand(brand);
    CCBrand.applyBrand(brand);
    fill();
    CCBrand.renderHeader("settings.html");
    CCBrand.toast("Brand kit reset to default.");
  });
});
