"use strict";
// app.ts - モノリシックPWAアプリケーション（TensorFlow.js K-means版）
// レート制限用の変数
let lastApiCallTime = 0;
const MIN_API_INTERVAL = 3000; // 3秒
// グローバル設定
const CONFIG = {
    API_ENDPOINT: "/api/traffic",
    CACHE_NAME: "traffic-map-v1",
    TILE_LAYERS: {
        standard: {
            url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
            attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
        },
        pale: {
            url: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
            attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
        },
        photo: {
            url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
            attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
        },
        blank: {
            url: "https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png",
            attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
        },
    },
};
// 主要都市
const CITY_COORDINATES = {
    tokyo: { name: "東京", lat: 35.6812, lon: 139.7671 },
    osaka: { name: "大阪", lat: 34.6937, lon: 135.5023 },
    nagoya: { name: "名古屋", lat: 35.1815, lon: 136.9066 },
    sapporo: { name: "札幌", lat: 43.0642, lon: 141.3469 },
    fukuoka: { name: "福岡", lat: 33.5904, lon: 130.4017 },
    sendai: { name: "仙台", lat: 38.2682, lon: 140.8694 },
    hiroshima: { name: "広島", lat: 34.3853, lon: 132.4553 },
    kyoto: { name: "京都", lat: 35.0116, lon: 135.7681 },
    yokohama: { name: "横浜", lat: 35.4437, lon: 139.638 },
    kobe: { name: "神戸", lat: 34.6901, lon: 135.1955 },
};
// 地方区分
const REGION_COORDINATES = {
    hokkaido: {
        name: "北海道",
        lat: 43.2203,
        lon: 142.8635,
        zoom: 7,
        cities: ["札幌", "函館", "旭川"],
    },
    tohoku: {
        name: "東北",
        lat: 39.7036,
        lon: 140.9728,
        zoom: 7,
        cities: ["仙台", "青森", "盛岡"],
    },
    kanto: {
        name: "関東",
        lat: 35.905,
        lon: 139.6237,
        zoom: 8,
        cities: ["東京", "横浜", "千葉"],
    },
    chubu: {
        name: "中部",
        lat: 36.0,
        lon: 137.5,
        zoom: 7,
        cities: ["名古屋", "静岡", "新潟"],
    },
    kinki: {
        name: "近畿",
        lat: 34.6857,
        lon: 135.5192,
        zoom: 8,
        cities: ["大阪", "京都", "神戸"],
    },
    chugoku: {
        name: "中国",
        lat: 34.9,
        lon: 133.0,
        zoom: 7,
        cities: ["広島", "岡山", "山口"],
    },
    shikoku: {
        name: "四国",
        lat: 33.8416,
        lon: 133.45,
        zoom: 8,
        cities: ["高松", "松山", "高知"],
    },
    kyushu: {
        name: "九州・沖縄",
        lat: 31.9077,
        lon: 130.9847,
        zoom: 7,
        cities: ["福岡", "鹿児島", "那覇"],
    },
};
// クラスター色
const CLUSTER_COLORS = [
    "#ff6b6b",
    "#4ecdc4",
    "#45b7d1",
    "#f9ca24",
    "#6c5ce7",
    "#a29bfe",
    "#fd79a8",
    "#fdcb6e",
];
// グローバル状態
const state = {
    map: null,
    currentData: [],
    isLoading: false,
    clientId: generateClientId(),
    lastUpdate: null,
    db: null,
    conn: null,
    markerGroup: null,
    clusterGroup: null,
    voronoiGroup: null,
    searchCircle: null,
    searchCenter: null,
    currentTileLayer: null,
    superclusterIndex: null,
    highlightedMarkers: new Map(),
    spatialEnabled: false,
    hotspotLayer: null,
    tfReady: false,
};
// TensorFlow.jsのグローバル変数
let tf = null;
// ユーティリティ関数
function generateClientId() {
    const stored = localStorage.getItem("traffic-map-client-id");
    if (stored)
        return stored;
    const id = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem("traffic-map-client-id", id);
    return id;
}
function showMessage(type, message) {
    const errorElement = document.getElementById("errorMessage");
    const successElement = document.getElementById("successMessage");
    errorElement.classList.remove("active");
    successElement.classList.remove("active");
    const element = type === "error" ? errorElement : successElement;
    element.textContent = message;
    element.classList.add("active");
    if (message.length < 100) {
        setTimeout(() => element.classList.remove("active"), type === "error" ? 5000 : 3000);
    }
}
function hideMessage() {
    document.getElementById("errorMessage")?.classList.remove("active");
    document.getElementById("successMessage")?.classList.remove("active");
}
function formatDateTime(date) {
    return date.toLocaleString("ja-JP");
}
function getTrafficColor(volume) {
    if (volume <= 50)
        return "#22c55e";
    if (volume <= 200)
        return "#f59e0b";
    return "#ef4444";
}
// パーセンタイル計算関数を追加
function calculatePercentile(data, value) {
    const sorted = [...data].sort((a, b) => a - b);
    const index = sorted.findIndex((v) => v >= value);
    if (index === -1)
        return 100;
    return (index / sorted.length) * 100;
}
// 渋滞レベル判定関数を追加
function getCongestionLevel(_volume, percentile) {
    if (percentile >= 90)
        return "非常に混雑";
    if (percentile >= 70)
        return "混雑";
    if (percentile >= 30)
        return "普通";
    return "空いている";
}
// TensorFlow.jsの初期化
async function initializeTensorFlow() {
    try {
        // TensorFlow.jsをCDNから読み込み
        const script = document.createElement("script");
        script.src =
            "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@latest/dist/tf.min.js";
        script.onload = async () => {
            // @ts-ignore
            tf = window.tf;
            console.log("TensorFlow.js loaded successfully");
            state.tfReady = true;
            // MLボタンを有効化
            const mlBtn = document.getElementById("mlBtn");
            if (mlBtn) {
                mlBtn.classList.remove("disabled");
                mlBtn.disabled = false;
                mlBtn.innerHTML =
                    '<i class="fas fa-brain"></i> TF.js K-means';
            }
        };
        document.head.appendChild(script);
    }
    catch (error) {
        console.error("TensorFlow.js initialization error:", error);
    }
}
// TensorFlow.jsを使ったk-meansクラスタリング
async function performTensorFlowAnalysis() {
    if (!tf || !state.tfReady || state.currentData.length === 0) {
        showMessage("error", "TensorFlow.jsが未初期化またはデータがありません");
        return;
    }
    const btn = document.getElementById("mlBtn");
    const loading = document.getElementById("loading");
    btn.disabled = true;
    loading.classList.add("active");
    hideMessage();
    try {
        // クラスター数
        const k = 5;
        // データの準備（正規化された特徴量）
        const bounds = {
            latMin: Math.min(...state.currentData.map((d) => d.latitude)),
            latMax: Math.max(...state.currentData.map((d) => d.latitude)),
            lonMin: Math.min(...state.currentData.map((d) => d.longitude)),
            lonMax: Math.max(...state.currentData.map((d) => d.longitude)),
            volMin: Math.min(...state.currentData.map((d) => d.volume)),
            volMax: Math.max(...state.currentData.map((d) => d.volume)),
        };
        // 3次元特徴量（緯度、経度、交通量）
        const features = state.currentData.map((point) => [
            (point.latitude - bounds.latMin) / (bounds.latMax - bounds.latMin || 1),
            (point.longitude - bounds.lonMin) / (bounds.lonMax - bounds.lonMin || 1),
            (point.volume - bounds.volMin) / (bounds.volMax - bounds.volMin || 1),
        ]);
        // テンソルに変換
        const dataTensor = tf.tensor2d(features);
        // k-means++初期化（TensorFlow.js版）
        const centroids = await initializeKMeansPlusPlus(dataTensor, k);
        // k-meansクラスタリング実行
        const maxIterations = 50;
        let currentCentroids = centroids;
        let assignments = [];
        for (let iter = 0; iter < maxIterations; iter++) {
            // 各点から各セントロイドまでの距離を計算
            const expandedData = dataTensor.expandDims(1); // [N, 1, 3]
            const expandedCentroids = currentCentroids.expandDims(0); // [1, k, 3]
            // ユークリッド距離の計算
            const distances = expandedData
                .sub(expandedCentroids)
                .square()
                .sum(2)
                .sqrt();
            // 最も近いセントロイドを見つける
            const newAssignments = (await distances.argMin(1).array());
            // 収束チェック
            if (iter > 0 && assignments.every((a, i) => a === newAssignments[i])) {
                console.log(`Converged at iteration ${iter}`);
                break;
            }
            assignments = newAssignments;
            // 新しいセントロイドを計算
            const newCentroids = [];
            for (let i = 0; i < k; i++) {
                const clusterIndices = assignments
                    .map((a, idx) => (a === i ? idx : -1))
                    .filter((idx) => idx !== -1);
                if (clusterIndices.length > 0) {
                    const clusterData = tf.gather(dataTensor, clusterIndices);
                    const mean = (await clusterData.mean(0).array());
                    newCentroids.push(mean);
                    clusterData.dispose();
                }
                else {
                    // 空のクラスターの場合は前のセントロイドを保持
                    const prevCentroid = (await currentCentroids
                        .slice([i, 0], [1, -1])
                        .squeeze()
                        .array());
                    newCentroids.push(prevCentroid);
                }
            }
            currentCentroids.dispose();
            currentCentroids = tf.tensor2d(newCentroids);
            distances.dispose();
        }
        // 結果の処理
        const clusteredData = state.currentData.map((point, idx) => ({
            ...point,
            cluster: assignments[idx],
            features: features[idx],
        }));
        // クラスター統計を計算
        const clusterStats = calculateClusterStats(clusteredData);
        // 結果を表示
        displaySpatialClusters(clusteredData);
        let message = `【TensorFlow.js K-meansクラスタリング結果】\n`;
        message += `${k}個のクラスターに分類しました\n\n`;
        clusterStats.forEach((stat, idx) => {
            message += `クラスター${idx + 1}: ${stat.count}地点\n`;
            message += `  平均交通量: ${Math.round(stat.avgVolume)}台/5分\n`;
            message += `  中心位置: (${stat.center.lat.toFixed(4)}, ${stat.center.lon.toFixed(4)})\n\n`;
        });
        message += "※位置情報と交通量の両方を考慮したクラスタリングです";
        showMessage("success", message);
        // テンソルのクリーンアップ
        dataTensor.dispose();
        currentCentroids.dispose();
    }
    catch (error) {
        console.error("TensorFlow k-means error:", error);
        showMessage("error", "K-meansクラスタリングに失敗しました");
    }
    finally {
        btn.disabled = false;
        loading.classList.remove("active");
    }
}
// k-means++初期化（TensorFlow.js版）
async function initializeKMeansPlusPlus(data, k) {
    const numPoints = data.shape[0];
    const centers = [];
    // 最初の中心をランダムに選択
    const firstIdx = Math.floor(Math.random() * numPoints);
    const firstCenter = (await data
        .slice([firstIdx, 0], [1, -1])
        .array());
    centers.push(firstCenter[0]);
    // 残りのk-1個の中心を選択
    for (let i = 1; i < k; i++) {
        // 各点から最も近い中心までの距離を計算
        const centersTensor = tf.tensor2d(centers);
        const expandedData = data.expandDims(1);
        const expandedCenters = centersTensor.expandDims(0);
        const distances = expandedData.sub(expandedCenters).square().sum(2).sqrt();
        const minDistances = distances.min(1);
        // 距離の二乗を確率として使用
        const probabilities = minDistances.square();
        const cumSum = (await probabilities.cumsum().array());
        const total = cumSum[cumSum.length - 1];
        // ルーレット選択
        const random = Math.random() * total;
        let selectedIdx = cumSum.findIndex((val) => val >= random);
        if (selectedIdx === -1)
            selectedIdx = numPoints - 1;
        const newCenter = (await data
            .slice([selectedIdx, 0], [1, -1])
            .array());
        centers.push(newCenter[0]);
        // クリーンアップ
        centersTensor.dispose();
        distances.dispose();
        minDistances.dispose();
        probabilities.dispose();
    }
    return tf.tensor2d(centers);
}
// DuckDB初期化（Spatial拡張付き）
async function initializeDuckDB() {
    try {
        // @ts-ignore
        const duckdb = await import("https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.1-dev106.0/+esm");
        // CDNから直接WASMとWorkerファイルを取得
        const MANUAL_BUNDLES = {
            eh: {
                mainModule: "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.1-dev106.0/dist/duckdb-eh.wasm",
                mainWorker: "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.1-dev106.0/dist/duckdb-browser-eh.worker.js",
            },
        };
        // Workerを作成
        const workerUrl = URL.createObjectURL(new Blob([`importScripts("${MANUAL_BUNDLES.eh.mainWorker}");`], {
            type: "text/javascript",
        }));
        const worker = new Worker(workerUrl);
        const logger = new duckdb.ConsoleLogger();
        state.db = new duckdb.AsyncDuckDB(logger, worker);
        // DuckDBインスタンスを初期化
        await state.db.instantiate(MANUAL_BUNDLES.eh.mainModule);
        URL.revokeObjectURL(workerUrl);
        state.conn = await state.db.connect();
        // Spatial拡張のインストールとロード
        try {
            console.log("Installing DuckDB extensions...");
            // 拡張をインストールしてロード（conn.queryを使用）
            await state.conn.query(`INSTALL json;`);
            await state.conn.query(`INSTALL spatial;`);
            await state.conn.query(`LOAD json;`);
            await state.conn.query(`LOAD spatial;`);
            // 動作確認のテスト
            const testResult = await state.conn.query(`
        SELECT ST_Point(139.7671, 35.6812) as test_point;
      `);
            console.log("Spatial test result:", testResult.toArray());
            state.spatialEnabled = true;
            console.log("DuckDB Spatial extension loaded successfully");
            document.getElementById("dbStatusIndicator")?.classList.add("ready");
            const dbStatusText = document.getElementById("dbStatusText");
            if (dbStatusText)
                dbStatusText.textContent = "DuckDB準備完了 (Spatial対応)";
            // ホットスポットボタンを有効化
            const hotspotBtn = document.getElementById("hotspotBtn");
            if (hotspotBtn) {
                hotspotBtn.classList.remove("disabled");
                hotspotBtn.disabled = false;
            }
        }
        catch (spatialError) {
            console.warn("Spatial extension not available:", spatialError);
            state.spatialEnabled = false;
            document.getElementById("dbStatusIndicator")?.classList.add("ready");
            const dbStatusText = document.getElementById("dbStatusText");
            if (dbStatusText)
                dbStatusText.textContent = "DuckDB準備完了";
        }
    }
    catch (error) {
        console.error("DuckDB initialization error:", error);
        const dbStatusText = document.getElementById("dbStatusText");
        if (dbStatusText)
            dbStatusText.textContent = "DuckDB（ローカルのみ）";
    }
}
// 空間ホットスポット検出
async function detectSpatialHotspots() {
    if (!state.conn || !state.spatialEnabled || state.currentData.length === 0) {
        showMessage("error", "ホットスポット検出にはSpatial拡張とデータが必要です");
        return;
    }
    const btn = document.getElementById("hotspotBtn");
    const loading = document.getElementById("loading");
    btn.disabled = true;
    loading.classList.add("active");
    hideMessage();
    try {
        // 一時テーブルを作成してデータをロード（インメモリ）
        await state.conn.query(`DROP TABLE IF EXISTS traffic_points;`);
        await state.conn.query(`
      CREATE TEMP TABLE traffic_points (
        id VARCHAR,
        name VARCHAR,
        latitude DOUBLE,
        longitude DOUBLE,
        traffic_volume INTEGER,
        geom GEOMETRY
      );
    `);
        // データを一括挿入
        const values = state.currentData
            .map((point) => `(
      '${point.id}',
      '${point.name.replace(/'/g, "''")}',
      ${point.latitude},
      ${point.longitude},
      ${point.volume},
      ST_Point(${point.longitude}, ${point.latitude})
    )`)
            .join(",");
        await state.conn.query(`
      INSERT INTO traffic_points VALUES ${values};
    `);
        // グリッドベースのホットスポット検出
        const gridSize = 0.1; // 約10km四方
        const result = await state.conn.query(`
      WITH grid_data AS (
        SELECT 
          FLOOR(latitude / ${gridSize}) * ${gridSize} + ${gridSize / 2} as lat_center,
          FLOOR(longitude / ${gridSize}) * ${gridSize} + ${gridSize / 2} as lon_center,
          AVG(traffic_volume) as avg_volume,
          COUNT(*) as point_count,
          LIST(geom) as geom_array,
          STRING_AGG(name, ', ') as point_names,
          MIN(latitude) as min_lat,
          MAX(latitude) as max_lat,
          MIN(longitude) as min_lon,
          MAX(longitude) as max_lon
        FROM traffic_points
        GROUP BY 
          FLOOR(latitude / ${gridSize}), 
          FLOOR(longitude / ${gridSize})
        HAVING COUNT(*) >= 2
      ),
      stats AS (
        SELECT 
          AVG(avg_volume) as mean_volume,
          STDDEV_SAMP(avg_volume) as std_volume
        FROM grid_data
      ),
      hotspots AS (
        SELECT 
          g.*,
          -- 地球の楕円体モデルを使用した面積計算の近似
          (g.max_lat - g.min_lat) * (g.max_lon - g.min_lon) * 111111.0 * 111111.0 * COS(RADIANS(g.lat_center)) as area_sqm,
          CASE 
            WHEN g.avg_volume > s.mean_volume + 2 * s.std_volume THEN '極度の混雑'
            WHEN g.avg_volume > s.mean_volume + s.std_volume THEN '混雑'
            WHEN g.avg_volume > s.mean_volume THEN 'やや混雑'
            ELSE '通常'
          END as congestion_level,
          (g.avg_volume - s.mean_volume) / NULLIF(s.std_volume, 0) as z_score
        FROM grid_data g, stats s
        WHERE g.avg_volume > s.mean_volume
      )
      SELECT 
        lat_center,
        lon_center,
        avg_volume,
        point_count,
        area_sqm,
        congestion_level,
        COALESCE(z_score, 0) as z_score,
        point_names,
        min_lon as bbox_min_lon,
        max_lon as bbox_max_lon,
        min_lat as bbox_min_lat,
        max_lat as bbox_max_lat
      FROM hotspots
      ORDER BY avg_volume DESC
      LIMIT 10;
    `);
        const hotspots = result.toArray();
        // ホットスポットを地図上に表示
        displayHotspots(hotspots);
        // 統計情報を表示
        let message = `【空間ホットスポット分析結果】\n`;
        message += `${hotspots.length}個のホットスポットを検出しました\n\n`;
        hotspots.slice(0, 5).forEach((spot, index) => {
            message += `${index + 1}. ${spot.congestion_level} - `;
            message += `平均${Math.round(spot.avg_volume)}台/5分 `;
            message += `(${spot.point_count}地点, Z値: ${spot.z_score.toFixed(2)})\n`;
        });
        showMessage("success", message);
        // 一時テーブルを削除
        await state.conn.query(`DROP TABLE traffic_points;`);
    }
    catch (error) {
        console.error("Hotspot detection error:", error);
        showMessage("error", "ホットスポット検出に失敗しました: " + error);
    }
    finally {
        btn.disabled = false;
        loading.classList.remove("active");
    }
}
// ホットスポットの表示
function displayHotspots(hotspots) {
    if (!state.map)
        return;
    // ホットスポットレイヤーが存在しない場合は作成
    if (!state.hotspotLayer) {
        state.hotspotLayer = L.layerGroup().addTo(state.map);
    }
    else {
        // 既存のホットスポットをクリア
        state.hotspotLayer.clearLayers();
    }
    hotspots.forEach((spot, index) => {
        const color = spot.congestion_level === "極度の混雑"
            ? "#ff0000"
            : spot.congestion_level === "混雑"
                ? "#ff6600"
                : spot.congestion_level === "やや混雑"
                    ? "#ffaa00"
                    : "#ffdd00";
        // バウンディングボックスの計算
        const bounds = [
            [spot.bbox_min_lat, spot.bbox_min_lon],
            [spot.bbox_max_lat, spot.bbox_max_lon],
        ];
        // 矩形で範囲を表示
        const rectangle = L.rectangle(bounds, {
            color: color,
            weight: 2,
            opacity: 0.8,
            fillColor: color,
            fillOpacity: 0.3,
        });
        // 中心点に円形のマーカーも追加
        const centerCircle = L.circle([spot.lat_center, spot.lon_center], {
            radius: Math.sqrt(spot.area_sqm / Math.PI) || 250,
            color: color,
            weight: 3,
            opacity: 1,
            fillColor: color,
            fillOpacity: 0.5,
        });
        const popupContent = `
      <div class="popup-content">
        <h4>ホットスポット #${index + 1}</h4>
        <div class="popup-row">
          <span class="popup-label">混雑レベル:</span>
          <span class="popup-value" style="color: ${color}; font-weight: bold;">
            ${spot.congestion_level}
          </span>
        </div>
        <div class="popup-row">
          <span class="popup-label">平均交通量:</span>
          <span class="popup-value">${Math.round(spot.avg_volume)} 台/5分</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">観測地点数:</span>
          <span class="popup-value">${spot.point_count} 箇所</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">範囲面積:</span>
          <span class="popup-value">${Math.round(spot.area_sqm / 10000)} ha</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">統計的異常度:</span>
          <span class="popup-value">Z値 = ${spot.z_score.toFixed(2)}</span>
        </div>
        <div class="popup-row" style="margin-top: 8px;">
          <span class="popup-label">含まれる地点:</span>
          <div style="font-size: 11px; color: #666; margin-top: 4px;">
            ${spot.point_names}
          </div>
        </div>
      </div>
    `;
        rectangle.bindPopup(popupContent);
        centerCircle.bindPopup(popupContent);
        state.hotspotLayer?.addLayer(rectangle);
        state.hotspotLayer?.addLayer(centerCircle);
        // ラベルを追加
        const label = L.marker([spot.lat_center, spot.lon_center], {
            icon: L.divIcon({
                className: "hotspot-label",
                html: `<div style="
          background: ${color};
          color: white;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: bold;
          white-space: nowrap;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        ">#${index + 1}</div>`,
                iconSize: [30, 20],
                iconAnchor: [15, 10],
            }),
        });
        state.hotspotLayer?.addLayer(label);
    });
}
// 地図初期化
function initializeMap() {
    const defaultCity = document.getElementById("citySelector").value;
    const cityData = CITY_COORDINATES[defaultCity];
    state.map = L.map("map").setView([cityData.lat, cityData.lon], 11);
    // デフォルトタイル
    const defaultTile = CONFIG.TILE_LAYERS.standard;
    state.currentTileLayer = L.tileLayer(defaultTile.url, {
        attribution: defaultTile.attribution,
        ...defaultTile.options,
    });
    state.currentTileLayer.addTo(state.map);
    state.markerGroup = L.layerGroup().addTo(state.map);
    state.clusterGroup = L.layerGroup().addTo(state.map);
    state.voronoiGroup = L.layerGroup().addTo(state.map);
    // 地図クリック
    state.map.on("click", (e) => {
        updateSearchCircle(e.latlng);
    });
}
// タイルレイヤー変更
function changeTileLayer(tileType) {
    if (!state.map || !state.currentTileLayer)
        return;
    state.map.removeLayer(state.currentTileLayer);
    const tileConfig = CONFIG.TILE_LAYERS[tileType];
    state.currentTileLayer = L.tileLayer(tileConfig.url, {
        attribution: tileConfig.attribution,
        ...tileConfig.options,
    });
    state.currentTileLayer.addTo(state.map);
}
// 検索範囲更新
function updateSearchCircle(center, radius) {
    if (!state.map)
        return;
    const searchRadius = radius ||
        parseInt(document.getElementById("searchRadius").value);
    if (state.searchCircle) {
        state.map.removeLayer(state.searchCircle);
    }
    state.searchCenter = center;
    state.searchCircle = L.circle(center, {
        radius: searchRadius,
        fillColor: "#4a9eff",
        fillOpacity: 0.1,
        color: "#4a9eff",
        weight: 2,
    }).addTo(state.map);
}
// APIからデータ取得（レート制限付き）
async function fetchTrafficData() {
    if (state.isLoading || !state.map)
        return;
    // レート制限チェック
    const now = Date.now();
    const timeSinceLastCall = now - lastApiCallTime;
    if (timeSinceLastCall < MIN_API_INTERVAL) {
        const waitTime = Math.ceil((MIN_API_INTERVAL - timeSinceLastCall) / 1000);
        showMessage("error", `次のリクエストまで${waitTime}秒お待ちください`);
        return;
    }
    const btn = document.getElementById("updateBtn");
    const loading = document.getElementById("loading");
    state.isLoading = true;
    btn.disabled = true;
    loading.classList.add("active");
    hideMessage();
    // APIコール時刻を記録
    lastApiCallTime = now;
    try {
        const center = state.map.getCenter();
        const radius = document.getElementById("searchRadius")
            .value;
        const searchTime = document.getElementById("searchTime").value;
        const params = new URLSearchParams({
            latitude: center.lat.toString(),
            longitude: center.lng.toString(),
            distance: radius,
        });
        if (searchTime) {
            params.append("search_time", searchTime);
        }
        const response = await fetch(`${CONFIG.API_ENDPOINT}?${params}`, {
            headers: {
                "X-Client-Id": state.clientId,
            },
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `APIエラー: ${response.status}`);
        }
        const data = await response.json();
        if (!data.data || data.data.length === 0) {
            throw new Error("指定された範囲内に観測地点がありません。");
        }
        // データ変換
        state.currentData = data.data.map((point) => ({
            id: point.observation_point_id,
            name: point.observation_point_name,
            latitude: point.latitude,
            longitude: point.longitude,
            datetime: point.observation_date_time,
            volume: point.traffic_volume || 0,
            small: point.small_vehicle || 0,
            large: point.large_vehicle || 0,
            direction: point.direction || "不明",
            road: point.road_name || "不明",
        }));
        // 地図更新
        updateMap();
        state.lastUpdate = new Date();
        const lastUpdateElement = document.getElementById("lastUpdate");
        if (lastUpdateElement) {
            lastUpdateElement.textContent = formatDateTime(state.lastUpdate);
        }
        showMessage("success", `${state.currentData.length}件の観測地点データを取得しました`);
    }
    catch (error) {
        console.error("Error fetching traffic data:", error);
        showMessage("error", error.message);
    }
    finally {
        state.isLoading = false;
        loading.classList.remove("active");
        // 3秒後にボタンを再度有効化
        setTimeout(() => {
            btn.disabled = false;
        }, MIN_API_INTERVAL);
    }
}
// 地図更新
function updateMap() {
    if (!state.map ||
        !state.markerGroup ||
        !state.clusterGroup ||
        !state.voronoiGroup)
        return;
    // レイヤークリア
    state.markerGroup.clearLayers();
    state.clusterGroup.clearLayers();
    state.voronoiGroup.clearLayers();
    state.highlightedMarkers.clear();
    // ホットスポットレイヤーもクリア
    if (state.hotspotLayer) {
        state.hotspotLayer.clearLayers();
    }
    // マーカー追加
    state.currentData.forEach((point) => {
        const color = getTrafficColor(point.volume);
        const radius = 8 + Math.min(point.volume / 10, 20);
        const marker = L.circleMarker([point.latitude, point.longitude], {
            radius: radius,
            fillColor: color,
            color: "#fff",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8,
        });
        const popupContent = `
      <div class="popup-content">
        <h4>${point.name}</h4>
        <div class="popup-row">
          <span class="popup-label">道路:</span>
          <span class="popup-value">${point.road}</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">交通量:</span>
          <span class="popup-value">${point.volume} 台/5分</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">小型車:</span>
          <span class="popup-value">${point.small} 台</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">大型車:</span>
          <span class="popup-value">${point.large} 台</span>
        </div>
      </div>
    `;
        marker.bindPopup(popupContent);
        state.markerGroup?.addLayer(marker);
    });
    // 表示範囲調整
    if (state.currentData.length > 0) {
        const bounds = L.latLngBounds(state.currentData.map((d) => [d.latitude, d.longitude]));
        state.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
    }
}
// 分析実行
async function performAnalysis() {
    if (state.currentData.length === 0) {
        showMessage("error", "分析するデータがありません。先にデータを取得してください。");
        return;
    }
    const btn = document.getElementById("analyzeBtn");
    const loading = document.getElementById("loading");
    btn.disabled = true;
    loading.classList.add("active");
    hideMessage();
    try {
        let message = "【交通量分析結果】\n";
        message += `観測地点数: ${state.currentData.length}件\n\n`;
        // 基本統計
        const totalVolume = state.currentData.reduce((sum, p) => sum + p.volume, 0);
        const avgVolume = totalVolume / state.currentData.length;
        const maxVolume = Math.max(...state.currentData.map((p) => p.volume));
        const minVolume = Math.min(...state.currentData.map((p) => p.volume));
        message += "【基本統計】\n";
        message += `総交通量: ${totalVolume} 台/5分\n`;
        message += `平均交通量: ${Math.round(avgVolume)} 台/5分\n`;
        message += `最大交通量: ${maxVolume} 台/5分\n`;
        message += `最小交通量: ${minVolume} 台/5分\n`;
        // パーセンタイル分析を追加
        const volumes = state.currentData
            .map((p) => p.volume)
            .sort((a, b) => a - b);
        const p25 = volumes[Math.floor(volumes.length * 0.25)];
        const p50 = volumes[Math.floor(volumes.length * 0.5)];
        const p75 = volumes[Math.floor(volumes.length * 0.75)];
        const p90 = volumes[Math.floor(volumes.length * 0.9)];
        const p95 = volumes[Math.floor(volumes.length * 0.95)];
        message += "\n【渋滞度分布】\n";
        message += `第1四分位(25%): ${p25} 台/5分\n`;
        message += `中央値(50%): ${p50} 台/5分\n`;
        message += `第3四分位(75%): ${p75} 台/5分\n`;
        message += `上位10%閾値: ${p90} 台/5分\n`;
        message += `上位5%閾値: ${p95} 台/5分\n`;
        // TOP5（渋滞レベル付き）
        const rankedData = state.currentData.map((point) => {
            const percentile = calculatePercentile(volumes, point.volume);
            const congestionLevel = getCongestionLevel(point.volume, percentile);
            return {
                ...point,
                rank: 0, // 後で設定
                percentile,
                congestionLevel,
            };
        });
        // ランクを設定
        rankedData.sort((a, b) => b.volume - a.volume);
        rankedData.forEach((point, index) => {
            point.rank = index + 1;
        });
        const topPoints = rankedData.slice(0, 5);
        message += "\n【現在の渋滞地点TOP5】\n";
        topPoints.forEach((point, index) => {
            message += `${index + 1}. ${point.name}: ${point.volume} 台/5分 [${point.congestionLevel}]\n`;
        });
        // TOP5リスト表示（拡張版）
        displayEnhancedTopPoints(topPoints);
        showMessage("success", message);
    }
    catch (error) {
        console.error("Analysis error:", error);
        showMessage("error", "分析に失敗しました: " + error.message);
    }
    finally {
        btn.disabled = false;
        loading.classList.remove("active");
    }
}
// 拡張TOP5表示
function displayEnhancedTopPoints(topPoints) {
    const container = document.getElementById("topPointsContainer");
    const listElement = document.getElementById("topPointsList");
    if (!container || !listElement)
        return;
    container.innerHTML = "";
    topPoints.forEach((point, index) => {
        const congestionColor = {
            非常に混雑: "#ef4444",
            混雑: "#f59e0b",
            普通: "#3b82f6",
            空いている: "#22c55e",
        }[point.congestionLevel || "普通"] || "#999";
        const item = document.createElement("div");
        item.className = "top-point-item";
        item.dataset.pointId = point.id;
        item.innerHTML = `
      <div style="display: flex; align-items: center; flex: 1;">
        <div class="top-point-rank">${index + 1}</div>
        <div class="top-point-info" style="flex: 1;">
          <div class="top-point-name">${point.name}</div>
          <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
            <span class="top-point-volume">${point.volume} 台/5分</span>
            <span style="
              background: ${congestionColor}; 
              color: white; 
              padding: 2px 8px; 
              border-radius: 4px; 
              font-size: 10px;
              font-weight: 600;
            ">${point.congestionLevel}</span>
            ${point.percentile !== undefined
            ? `
              <span style="font-size: 10px; color: #999;">
                上位${Math.round(100 - point.percentile)}%
              </span>
            `
            : ""}
          </div>
        </div>
      </div>
      <div class="top-point-arrow">→</div>
    `;
        item.addEventListener("click", () => highlightMarker(point));
        container.appendChild(item);
    });
    listElement.classList.add("active");
}
// マーカーハイライト
function highlightMarker(point) {
    if (!state.markerGroup || !state.map)
        return;
    state.highlightedMarkers.forEach((marker) => {
        marker.setStyle({ weight: 2, opacity: 1 });
    });
    state.highlightedMarkers.clear();
    state.markerGroup.eachLayer((layer) => {
        if (layer instanceof L.CircleMarker) {
            const latlng = layer.getLatLng();
            if (Math.abs(latlng.lat - point.latitude) < 0.0001 &&
                Math.abs(latlng.lng - point.longitude) < 0.0001) {
                layer.setStyle({ weight: 4, opacity: 1, color: "#fff" });
                layer.openPopup();
                state.highlightedMarkers.set(point.id, layer);
                // 地図の中心を移動
                if (state.map) {
                    state.map.setView([point.latitude, point.longitude], state.map.getZoom());
                }
            }
        }
    });
}
// クラスター分析（k-means法による真の空間的クラスタリング）
async function performClusterAnalysis() {
    if (state.currentData.length === 0) {
        showMessage("error", "クラスター分析するデータがありません。");
        return;
    }
    const btn = document.getElementById("clusterBtn");
    const loading = document.getElementById("loading");
    btn.disabled = true;
    loading.classList.add("active");
    hideMessage();
    try {
        // k-means法による空間的クラスタリング（5クラスター）
        const clusteredData = performKMeansClustering(state.currentData, 5);
        // クラスター結果を表示
        displaySpatialClusters(clusteredData);
        // クラスターごとの統計情報
        const clusterStats = calculateClusterStats(clusteredData);
        let message = `空間的クラスター分析完了\n${clusterStats.length}個のグループに分類しました\n\n`;
        clusterStats.forEach((stat, idx) => {
            message += `グループ${idx + 1}: ${stat.count}地点, 平均交通量: ${Math.round(stat.avgVolume)}台/5分\n`;
        });
        showMessage("success", message);
    }
    catch (error) {
        console.error("Cluster analysis error:", error);
        showMessage("error", "クラスター分析に失敗しました: " + error.message);
    }
    finally {
        btn.disabled = false;
        loading.classList.remove("active");
    }
}
// k-means法によるクラスタリング
function performKMeansClustering(data, k) {
    if (data.length < k) {
        k = data.length;
    }
    // データを正規化
    const bounds = {
        latMin: Math.min(...data.map((d) => d.latitude)),
        latMax: Math.max(...data.map((d) => d.latitude)),
        lonMin: Math.min(...data.map((d) => d.longitude)),
        lonMax: Math.max(...data.map((d) => d.longitude)),
    };
    // 特徴ベクトルを作成（位置のみ使用）
    const points = data.map((d) => ({
        ...d,
        features: [
            (d.latitude - bounds.latMin) / (bounds.latMax - bounds.latMin || 1),
            (d.longitude - bounds.lonMin) / (bounds.lonMax - bounds.lonMin || 1),
        ],
        cluster: 0,
    }));
    // k-means++法で初期中心点を選択
    const centers = [];
    // 最初の中心点をランダムに選択
    const firstIdx = Math.floor(Math.random() * points.length);
    centers.push([...points[firstIdx].features]);
    // 残りの中心点を確率的に選択
    for (let i = 1; i < k; i++) {
        const distances = points.map((point) => {
            const minDist = centers.reduce((min, center) => {
                const dist = euclideanDistance(point.features, center);
                return dist < min ? dist : min;
            }, Infinity);
            return minDist * minDist;
        });
        const totalDist = distances.reduce((sum, d) => sum + d, 0);
        let random = Math.random() * totalDist;
        for (let j = 0; j < points.length; j++) {
            random -= distances[j];
            if (random <= 0) {
                centers.push([...points[j].features]);
                break;
            }
        }
    }
    // k-meansアルゴリズム
    let changed = true;
    let iterations = 0;
    const maxIterations = 100;
    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;
        // 各点を最も近い中心に割り当て
        points.forEach((point) => {
            let minDist = Infinity;
            let newCluster = 0;
            centers.forEach((center, idx) => {
                const dist = euclideanDistance(point.features, center);
                if (dist < minDist) {
                    minDist = dist;
                    newCluster = idx;
                }
            });
            if (point.cluster !== newCluster) {
                point.cluster = newCluster;
                changed = true;
            }
        });
        // 中心点を更新
        for (let i = 0; i < k; i++) {
            const clusterPoints = points.filter((p) => p.cluster === i);
            if (clusterPoints.length > 0) {
                centers[i] = [
                    clusterPoints.reduce((sum, p) => sum + p.features[0], 0) /
                        clusterPoints.length,
                    clusterPoints.reduce((sum, p) => sum + p.features[1], 0) /
                        clusterPoints.length,
                ];
            }
        }
    }
    return points;
}
// ユークリッド距離
function euclideanDistance(a, b) {
    return Math.sqrt(a.reduce((sum, val, i) => sum + Math.pow(val - b[i], 2), 0));
}
// クラスターごとの統計を計算
function calculateClusterStats(clusteredData) {
    const stats = [];
    const maxCluster = Math.max(...clusteredData.map((d) => d.cluster));
    for (let i = 0; i <= maxCluster; i++) {
        const clusterPoints = clusteredData.filter((p) => p.cluster === i);
        if (clusterPoints.length > 0) {
            stats.push({
                cluster: i,
                count: clusterPoints.length,
                avgVolume: clusterPoints.reduce((sum, p) => sum + p.volume, 0) /
                    clusterPoints.length,
                center: {
                    lat: clusterPoints.reduce((sum, p) => sum + p.latitude, 0) /
                        clusterPoints.length,
                    lon: clusterPoints.reduce((sum, p) => sum + p.longitude, 0) /
                        clusterPoints.length,
                },
            });
        }
    }
    return stats;
}
// 空間的クラスターを表示
function displaySpatialClusters(clusteredData) {
    if (!state.map || !state.clusterGroup || !state.markerGroup)
        return;
    // 既存のレイヤーをクリア
    state.clusterGroup.clearLayers();
    state.markerGroup.clearLayers();
    // クラスターごとの統計を計算
    const clusterStats = calculateClusterStats(clusteredData);
    // 各点をクラスターの色でマーカー表示
    clusteredData.forEach((point) => {
        const color = CLUSTER_COLORS[point.cluster % CLUSTER_COLORS.length];
        const radius = 8 + Math.min(point.volume / 10, 20);
        const marker = L.circleMarker([point.latitude, point.longitude], {
            radius: radius,
            fillColor: color,
            color: "#fff",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8,
        });
        const popupContent = `
      <div class="popup-content">
        <h4>${point.name}</h4>
        <div class="popup-row">
          <span class="popup-label">グループ:</span>
          <span class="popup-value" style="color: ${color}; font-weight: bold;">
            ${point.cluster + 1}
          </span>
        </div>
        <div class="popup-row">
          <span class="popup-label">道路:</span>
          <span class="popup-value">${point.road}</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">交通量:</span>
          <span class="popup-value">${point.volume} 台/5分</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">小型車:</span>
          <span class="popup-value">${point.small} 台</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">大型車:</span>
          <span class="popup-value">${point.large} 台</span>
        </div>
      </div>
    `;
        marker.bindPopup(popupContent);
        state.markerGroup?.addLayer(marker);
    });
    // クラスター中心を表示
    clusterStats.forEach((stat, idx) => {
        const color = CLUSTER_COLORS[idx % CLUSTER_COLORS.length];
        // 中心点のアイコン
        const icon = L.divIcon({
            html: `<div style="
        background: ${color}; 
        width: 50px; 
        height: 50px; 
        border-radius: 50%; 
        border: 4px solid white; 
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        display: flex; 
        align-items: center; 
        justify-content: center; 
        color: white; 
        font-weight: bold; 
        font-size: 18px;
      ">${idx + 1}</div>`,
            iconSize: [50, 50],
            className: "cluster-center-marker",
        });
        const marker = L.marker([stat.center.lat, stat.center.lon], { icon });
        const popupContent = `
      <div class="popup-content">
        <h4 style="color: ${color};">グループ ${idx + 1} 中心</h4>
        <div class="popup-row">
          <span class="popup-label">地点数:</span>
          <span class="popup-value">${stat.count} 箇所</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">平均交通量:</span>
          <span class="popup-value">${Math.round(stat.avgVolume)} 台/5分</span>
        </div>
      </div>
    `;
        marker.bindPopup(popupContent);
        state.clusterGroup?.addLayer(marker);
        // クラスター範囲を円で表示（オプション）
        const clusterPoints = clusteredData.filter((p) => p.cluster === idx);
        if (clusterPoints.length > 1) {
            const distances = clusterPoints.map((p) => {
                const lat1 = (stat.center.lat * Math.PI) / 180;
                const lat2 = (p.latitude * Math.PI) / 180;
                const deltaLat = ((p.latitude - stat.center.lat) * Math.PI) / 180;
                const deltaLon = ((p.longitude - stat.center.lon) * Math.PI) / 180;
                const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
                    Math.cos(lat1) *
                        Math.cos(lat2) *
                        Math.sin(deltaLon / 2) *
                        Math.sin(deltaLon / 2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                return 6371000 * c; // メートル単位
            });
            const avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
            const circle = L.circle([stat.center.lat, stat.center.lon], {
                radius: avgRadius,
                fillColor: color,
                fillOpacity: 0.1,
                color: color,
                weight: 1,
                opacity: 0.5,
            });
            state.clusterGroup?.addLayer(circle);
        }
    });
}
// イベントリスナー設定
function setupEventListeners() {
    // パネル開閉
    document.getElementById("panelToggle")?.addEventListener("click", () => {
        document.getElementById("controlPanel")?.classList.toggle("collapsed");
    });
    // タイル変更
    document.getElementById("tileSelector")?.addEventListener("change", (e) => {
        changeTileLayer(e.target.value);
    });
    // 検索半径
    document.getElementById("searchRadius")?.addEventListener("input", (e) => {
        const value = e.target.value;
        const radiusValue = document.getElementById("radiusValue");
        if (radiusValue)
            radiusValue.textContent = value;
        if (state.searchCenter) {
            updateSearchCircle(state.searchCenter, parseInt(value));
        }
    });
    // 重み設定（現在は使用されていないが、UIのために残す）
    document.getElementById("spatialWeight")?.addEventListener("input", (e) => {
        const value = e.target.value;
        const spatialValue = document.getElementById("spatialWeightValue");
        const volumeInput = document.getElementById("volumeWeight");
        const volumeValue = document.getElementById("volumeWeightValue");
        if (spatialValue)
            spatialValue.textContent = value + "%";
        if (volumeInput)
            volumeInput.value = (100 - parseInt(value)).toString();
        if (volumeValue)
            volumeValue.textContent = 100 - parseInt(value) + "%";
    });
    document.getElementById("volumeWeight")?.addEventListener("input", (e) => {
        const value = e.target.value;
        const volumeValue = document.getElementById("volumeWeightValue");
        const spatialInput = document.getElementById("spatialWeight");
        const spatialValue = document.getElementById("spatialWeightValue");
        if (volumeValue)
            volumeValue.textContent = value + "%";
        if (spatialInput)
            spatialInput.value = (100 - parseInt(value)).toString();
        if (spatialValue)
            spatialValue.textContent = 100 - parseInt(value) + "%";
    });
    // 地域選択
    document.querySelectorAll(".region-tile").forEach((tile) => {
        tile.addEventListener("click", function () {
            const regionKey = this.dataset.region;
            if (!regionKey || !state.map)
                return;
            const region = REGION_COORDINATES[regionKey];
            document
                .querySelectorAll(".region-tile")
                .forEach((t) => t.classList.remove("active"));
            this.classList.add("active");
            state.map.setView([region.lat, region.lon], region.zoom);
        });
    });
    // 都市選択
    document.getElementById("citySelector")?.addEventListener("change", (e) => {
        const city = CITY_COORDINATES[e.target.value];
        if (state.map && city) {
            state.map.setView([city.lat, city.lon], 11);
            updateSearchCircle(L.latLng(city.lat, city.lon));
        }
    });
    // ボタン
    document
        .getElementById("updateBtn")
        ?.addEventListener("click", fetchTrafficData);
    document
        .getElementById("analyzeBtn")
        ?.addEventListener("click", performAnalysis);
    document
        .getElementById("clusterBtn")
        ?.addEventListener("click", performClusterAnalysis);
    // ホットスポットボタン（存在する場合）
    const hotspotBtn = document.getElementById("hotspotBtn");
    if (hotspotBtn) {
        hotspotBtn.addEventListener("click", detectSpatialHotspots);
    }
    // MLボタン（存在する場合）
    const mlBtn = document.getElementById("mlBtn");
    if (mlBtn) {
        mlBtn.addEventListener("click", performTensorFlowAnalysis);
    }
}
// UI初期化
function initializeUI() {
    // 都市セレクタ
    const citySelector = document.getElementById("citySelector");
    Object.entries(CITY_COORDINATES).forEach(([key, city]) => {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = city.name;
        citySelector.appendChild(option);
    });
    // 地域グリッド
    const regionGrid = document.getElementById("regionGrid");
    if (regionGrid) {
        Object.entries(REGION_COORDINATES).forEach(([key, region]) => {
            const tile = document.createElement("div");
            tile.className = "region-tile";
            tile.dataset.region = key;
            tile.innerHTML = `
        <h3>${region.name}</h3>
        <p>${region.cities.join("・")}</p>
      `;
            regionGrid.appendChild(tile);
        });
    }
    // ホットスポットボタンを追加（HTMLに存在しない場合）
    const actionButtons = document.querySelector(".action-buttons");
    if (actionButtons && !document.getElementById("hotspotBtn")) {
        const hotspotBtn = document.createElement("button");
        hotspotBtn.id = "hotspotBtn";
        hotspotBtn.className = "control-btn disabled";
        hotspotBtn.disabled = true;
        hotspotBtn.innerHTML = '<i class="fas fa-fire"></i> ホットスポット検出';
        actionButtons.appendChild(hotspotBtn);
    }
    // MLボタンを追加（HTMLに存在しない場合）
    if (actionButtons && !document.getElementById("mlBtn")) {
        const mlBtn = document.createElement("button");
        mlBtn.id = "mlBtn";
        mlBtn.className = "control-btn disabled";
        mlBtn.disabled = true;
        mlBtn.innerHTML = '<i class="fas fa-brain"></i> TF.js K-means';
        actionButtons.appendChild(mlBtn);
    }
}
// アプリケーション初期化
async function initialize() {
    try {
        // ローディング画面
        const loadingScreen = document.getElementById("loading-screen");
        // UI初期化
        initializeUI();
        // 地図初期化
        initializeMap();
        // イベントリスナー
        setupEventListeners();
        // DuckDB初期化（非同期）
        initializeDuckDB();
        // TensorFlow.js初期化（非同期）
        initializeTensorFlow();
        // 初期検索範囲
        const defaultCity = CITY_COORDINATES.tokyo;
        updateSearchCircle(L.latLng(defaultCity.lat, defaultCity.lon));
        // ローディング画面非表示
        setTimeout(() => {
            loadingScreen?.classList.add("hide");
        }, 500);
        // 初期データ取得
        if (navigator.onLine) {
            setTimeout(() => {
                fetchTrafficData();
            }, 1000);
        }
    }
    catch (error) {
        console.error("Initialization error:", error);
        showMessage("error", "アプリケーションの初期化に失敗しました。");
    }
}
// Service Worker登録（修正版：POSTリクエストを除外）
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        // Service Workerの登録をスキップ（DuckDB-WASMとの互換性問題のため）
        console.log("Service Worker registration skipped for DuckDB-WASM compatibility");
    });
    // オンライン/オフライン
    window.addEventListener("online", () => {
        document
            .getElementById("offline-indicator")
            ?.style.setProperty("display", "none");
    });
    window.addEventListener("offline", () => {
        document
            .getElementById("offline-indicator")
            ?.style.setProperty("display", "block");
    });
}
// 初期化実行
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
}
else {
    initialize();
}
// グローバルエクスポート
window.TrafficMapApp = {
    state,
    fetchTrafficData,
    performAnalysis,
    performClusterAnalysis,
    detectSpatialHotspots,
    performTensorFlowAnalysis,
};
//# sourceMappingURL=app.js.map