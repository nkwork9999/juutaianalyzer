const https = require("https");
const querystring = require("querystring");

module.exports = (req, res) => {
  // CORS設定
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Client-Id");

  // OPTIONS処理
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // GETのみ許可
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // パラメータ取得
    const { latitude, longitude, distance } = req.query;

    // バリデーション
    if (!latitude || !longitude || !distance) {
      return res.status(400).json({
        error: "Missing parameters",
        required: ["latitude", "longitude", "distance"],
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const dist = parseInt(distance);

    // 現在時刻から30分前
    let searchDateTime;
    if (req.query.search_time) {
      searchDateTime = new Date(req.query.search_time);
    } else {
      searchDateTime = new Date();
      searchDateTime.setMinutes(searchDateTime.getMinutes() - 30);
    }

    // 5分単位に丸める
    const minutes = searchDateTime.getMinutes();
    searchDateTime.setMinutes(Math.floor(minutes / 5) * 5);
    searchDateTime.setSeconds(0);
    searchDateTime.setMilliseconds(0);

    // 時間コード生成
    const year = searchDateTime.getFullYear();
    const month = String(searchDateTime.getMonth() + 1).padStart(2, "0");
    const day = String(searchDateTime.getDate()).padStart(2, "0");
    const hour = String(searchDateTime.getHours()).padStart(2, "0");
    const minute = String(searchDateTime.getMinutes()).padStart(2, "0");
    const timeCode = year + month + day + hour + minute;

    // BBOX計算
    const distKm = dist / 1000;
    const degreePerKm = 1 / 111;
    const latDiff = distKm * degreePerKm;
    const lonDiff = (distKm * degreePerKm) / Math.cos((lat * Math.PI) / 180);

    const minLon = lon - lonDiff;
    const maxLon = lon + lonDiff;
    const minLat = lat - latDiff;
    const maxLat = lat + latDiff;

    // WFSパラメータ
    const wfsParams = {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: "t_travospublic_measure_5m",
      srsName: "EPSG:4326",
      outputFormat: "application/json",
      exceptions: "application/json",
      cql_filter: `道路種別='3' AND 時間コード=${timeCode} AND BBOX(ジオメトリ,${minLon},${minLat},${maxLon},${maxLat},'EPSG:4326')`,
    };

    const queryString = querystring.stringify(wfsParams);
    const apiUrl = `https://api.jartic-open-traffic.org/geoserver?${queryString}`;

    console.log("Calling API:", apiUrl.substring(0, 100) + "...");

    // API呼び出し
    https
      .get(apiUrl, (apiRes) => {
        let data = "";

        apiRes.on("data", (chunk) => {
          data += chunk;
        });

        apiRes.on("end", () => {
          try {
            const geoJson = JSON.parse(data);

            // レスポンス変換
            const transformedData = {
              status: "success",
              timestamp: new Date().toISOString(),
              search_params: {
                latitude: lat,
                longitude: lon,
                distance: dist,
                search_time: searchDateTime.toISOString(),
              },
              data: [],
            };

            if (geoJson.features && Array.isArray(geoJson.features)) {
              geoJson.features.forEach((feature, index) => {
                const props = feature.properties || {};

                // 座標取得
                let featureLat = lat;
                let featureLon = lon;
                if (feature.geometry && feature.geometry.coordinates) {
                  const coords = feature.geometry.coordinates;
                  if (
                    feature.geometry.type === "MultiPoint" &&
                    Array.isArray(coords[0])
                  ) {
                    [featureLon, featureLat] = coords[0];
                  } else if (Array.isArray(coords) && coords.length >= 2) {
                    [featureLon, featureLat] = coords;
                  }
                }

                // 交通量集計
                const upSmall = parseInt(
                  String(props["上り・小型交通量"] || 0)
                );
                const upLarge = parseInt(
                  String(props["上り・大型交通量"] || 0)
                );
                const downSmall = parseInt(
                  String(props["下り・小型交通量"] || 0)
                );
                const downLarge = parseInt(
                  String(props["下り・大型交通量"] || 0)
                );
                const totalVolume = upSmall + upLarge + downSmall + downLarge;

                transformedData.data.push({
                  observation_point_id:
                    props["常時観測点コード"] || `POINT_${index + 1}`,
                  observation_point_name: `観測地点 ${
                    props["常時観測点コード"] || index + 1
                  }`,
                  latitude: featureLat,
                  longitude: featureLon,
                  observation_date_time: searchDateTime.toISOString(),
                  traffic_volume: totalVolume,
                  small_vehicle: upSmall + downSmall,
                  large_vehicle: upLarge + downLarge,
                  direction: "上下合計",
                  road_name: `国道（地整${props["地方整備局等番号"] || ""}）`,
                });
              });
            }

            // データがない場合はモックデータを返す
            if (transformedData.data.length === 0) {
              transformedData.data = [
                {
                  observation_point_id: "NO_DATA",
                  observation_point_name: "データなし（テスト）",
                  latitude: lat,
                  longitude: lon,
                  observation_date_time: searchDateTime.toISOString(),
                  traffic_volume: 100,
                  small_vehicle: 80,
                  large_vehicle: 20,
                  direction: "テスト",
                  road_name: "テスト道路",
                },
              ];
              transformedData.message =
                "指定範囲・時間にデータがありませんでした";
            }

            res.status(200).json(transformedData);
          } catch (error) {
            console.error("Parse error:", error.message);
            res.status(500).json({
              error: "Data parse error",
              message: error.message,
            });
          }
        });
      })
      .on("error", (error) => {
        console.error("HTTPS error:", error.message);
        res.status(500).json({
          error: "API call failed",
          message: error.message,
        });
      });
  } catch (error) {
    console.error("Handler error:", error.message);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
    });
  }
};
