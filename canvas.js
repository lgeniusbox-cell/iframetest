const _defineProperty = Object.defineProperty;
const origParse = JSON.parse;
JSON.parse = function(text, reviver) {
    const obj = origParse(text, reviver);
    try {
        const ra = obj?.playerConfig?.mediaCommonConfig?.dynamicReadaheadConfig;
        if (ra) {
            console.log(ra);
            ra.maxReadAheadMediaTimeMs = 300000;
            ra.minReadAheadMediaTimeMs = 30000;
        }
    } catch (e) {}
    return obj;
};
