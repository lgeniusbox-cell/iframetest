const _defineProperty = Object.defineProperty;
const origParse = JSON.parse;
JSON.parse = function(text, reviver) {
    const obj = origParse(text, reviver);
    try {
        const ra = obj?.playerConfig?.mediaCommonConfig?.dynamicReadaheadConfig;
        if (ra) {
            console.log(obj?.playerConfig);
            obj.playerConfig.mediaCommonConfig.serverPlaybackStartConfig.playbackStartPolicy.startMinReadaheadPolicy[0].minReadaheadMs = 10000;
            ra.maxReadAheadMediaTimeMs = 500000;
            ra.minReadAheadMediaTimeMs = 100000;
           ra.readAheadGrowthRateMs = 6000;
        }
    } catch (e) {}
    return obj;
};
