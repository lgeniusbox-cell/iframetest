(function hookFetch() {
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch(input, init);
    const url = typeof input === "string" ? input : input.url;

    if (url.includes("/youtubei/v1/player")) {
      const clone = res.clone();
      let data = await clone.json();
      console.log(data);
      // Inject larger readahead config
      data.mediaCommonConfig = data.mediaCommonConfig || {};
      data.mediaCommonConfig.dynamicReadaheadConfig = {
        maxReadAheadMediaTimeMs: 300000,   // 5 min max buffer
        minReadAheadMediaTimeMs: 30000,
        readAheadGrowthRateMs: 2000,
      };

      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: res.headers,
      });
    }
    return res;
  };
})();
