const indicatorOptions = {
    ...sharedChartOptions,
    timeScale: {
        ...sharedChartOptions.timeScale,
        visible: false, // Time scale handled by main chart sync
    },
    layout: {
        background: { type: 'solid', color: '#131722' },
        textColor: '#D9D9D9',
    }
};

// RSI Chart
const rsiChart = LightweightCharts.createChart(document.getElementById('rsi-chart'), {
    ...indicatorOptions,
    rightPriceScale: {
        ...indicatorOptions.rightPriceScale,
        scaleMargins: { top: 0.1, bottom: 0.1 },
    }
});

const rsiSeries = rsiChart.addLineSeries({
    color: '#7e57c2',
    lineWidth: 2,
});

rsiSeries.createPriceLine({ price: 70, color: '#ef5350', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '70' });
rsiSeries.createPriceLine({ price: 30, color: '#26a69a', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '30' });
rsiSeries.createPriceLine({ price: 50, color: '#787B86', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: '50' });

// Stochastic Chart
const stochChart = LightweightCharts.createChart(document.getElementById('stoch-chart'), indicatorOptions);

const stochKSeries = stochChart.addLineSeries({
    color: '#2196F3', // blue
    lineWidth: 1,
});

const stochDSeries = stochChart.addLineSeries({
    color: '#FF6D00', // orange
    lineWidth: 1,
});

stochKSeries.createPriceLine({ price: 80, color: '#ef5350', lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '80' });
stochKSeries.createPriceLine({ price: 20, color: '#26a69a', lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '20' });

// Sync interaction from indicators back to main
rsiChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (isUpdating) return;
    isUpdating = true;
    mainChart.timeScale().setVisibleLogicalRange(range);
    stochChart.timeScale().setVisibleLogicalRange(range);
    isUpdating = false;
});

stochChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (isUpdating) return;
    isUpdating = true;
    mainChart.timeScale().setVisibleLogicalRange(range);
    rsiChart.timeScale().setVisibleLogicalRange(range);
    isUpdating = false;
});

rsiChart.subscribeCrosshairMove(param => {
    if (isUpdating) return;
    isUpdating = true;
    if (!param.time || !param.point) {
        mainChart.clearCrosshairPosition();
        if (typeof stochChart !== 'undefined') stochChart.clearCrosshairPosition();
    } else {
        mainChart.setCrosshairPosition(param.point.x, param.time, candleSeries);
        if (typeof stochChart !== 'undefined') stochChart.setCrosshairPosition(param.point.x, param.time, stochKSeries);
    }
    isUpdating = false;
});

stochChart.subscribeCrosshairMove(param => {
    if (isUpdating) return;
    isUpdating = true;
    if (!param.time || !param.point) {
        mainChart.clearCrosshairPosition();
        if (typeof rsiChart !== 'undefined') rsiChart.clearCrosshairPosition();
    } else {
        mainChart.setCrosshairPosition(param.point.x, param.time, candleSeries);
        if (typeof rsiChart !== 'undefined') rsiChart.setCrosshairPosition(param.point.x, param.time, rsiSeries);
    }
    isUpdating = false;
});
