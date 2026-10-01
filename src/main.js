function isMobilePhone(globalRef = window) {
  const navigatorData = globalRef.navigator.userAgentData;
  const mobileUserAgent =
    navigatorData?.mobile === true ||
    /(?:Mobi|iPhone|iPod|Windows Phone)/i.test(globalRef.navigator.userAgent);
  const coarsePhoneScreen =
    globalRef.matchMedia?.('(hover: none) and (pointer: coarse)').matches ===
      true && Math.min(globalRef.screen.width, globalRef.screen.height) <= 600;

  return mobileUserAgent || coarsePhoneScreen;
}

let application = null;

async function startDesktopApplication() {
  const [{ createStandaloneApplication }, { describeError }] =
    await Promise.all([
      import('./standalone/application.js'),
      import('./standalone/errors.js'),
    ]);

  application = createStandaloneApplication({
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
    allowQaRegistration: import.meta.env.DEV,
  });

  try {
    await application.start();
  } catch (error) {
    console.error('ANUBIS initialization failed:', error);
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  }
}

if (isMobilePhone()) {
  document.documentElement.dataset.mobileAccess = 'blocked';
} else {
  startDesktopApplication().catch((error) => {
    console.error('ANUBIS bootstrap failed:', error);
  });
}

export { application, isMobilePhone };
